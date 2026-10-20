package cloudflarestream

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	log "github.com/sirupsen/logrus"

	"github.com/owncast/owncast/services/stream"
)

const pollInterval = 5 * time.Second

var (
	errInvalidResponse  = errors.New("invalid Cloudflare Stream response")
	videoIDPattern      = regexp.MustCompile(`^[a-fA-F0-9]{32}$`)
	customerCodePattern = regexp.MustCompile(`^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$`)
)

// Config identifies the Cloudflare Stream live input and the customer
// delivery domain used for playback, lifecycle, views, and thumbnails.
type Config struct {
	baseURL *url.URL
	inputID string
}

// NewConfig validates the live input ID and customer code from the environment.
func NewConfig(inputID, customerCode string) (Config, error) {
	if !validVideoID(inputID) {
		return Config{}, errors.New("CLOUDFLARE_STREAM_LIVE_INPUT_ID must be a 32-character hexadecimal ID")
	}
	if len(customerCode) > 54 || !customerCodePattern.MatchString(customerCode) {
		return Config{}, errors.New("CLOUDFLARE_STREAM_CUSTOMER_CODE must be a nonempty customer hostname code")
	}
	return Config{
		baseURL: &url.URL{Scheme: "https", Host: "customer-" + customerCode + ".cloudflarestream.com"},
		inputID: inputID,
	}, nil
}

func validVideoID(id string) bool {
	return videoIDPattern.MatchString(id)
}

// Deps are the explicit dependencies of the Cloudflare Stream engine.
type Deps struct {
	Config Config
	// Client is optional; a copy of http.DefaultClient is used when nil.
	Client *http.Client
	Events stream.StreamEvents
}

type refreshState struct {
	lastSuccess time.Time
	nextAttempt time.Time
	failures    int
}

// Service polls a Cloudflare Stream live input and reports its lifecycle and
// viewer counts through stream.StreamEvents. It implements stream.StreamEngine
// and stream.ExternalPlayback.
type Service struct {
	config Config
	client *http.Client
	events stream.StreamEvents
	now    func() time.Time

	mu        sync.RWMutex
	live      bool
	videoUID  string
	viewers   int
	lifecycle refreshState
	views     refreshState

	runMu  sync.Mutex
	cancel context.CancelFunc
	done   chan struct{}
}

var (
	_ stream.StreamEngine     = (*Service)(nil)
	_ stream.ExternalPlayback = (*Service)(nil)
)

// New constructs an idle engine; Start begins polling.
func New(deps Deps) *Service {
	client := *http.DefaultClient
	if deps.Client != nil {
		client = *deps.Client
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &Service{config: deps.Config, client: &client, events: deps.Events, now: time.Now}
}

func (s *Service) endpoint(id, suffix string) string {
	result := *s.config.baseURL
	result.Path = "/" + id + "/" + suffix
	return result.String()
}

// PlaybackURL is the standard HLS manifest URL for the live input.
func (s *Service) PlaybackURL() string {
	return s.endpoint(s.config.inputID, "manifest/video.m3u8")
}

// ViewerCount is the last successfully polled live viewer count.
func (s *Service) ViewerCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.viewers
}

// ThumbnailURL is the provider thumbnail for the active video, or "" offline.
func (s *Service) ThumbnailURL() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if !s.live || s.videoUID == "" {
		return ""
	}
	return s.endpoint(s.videoUID, "thumbnails/thumbnail.jpg")
}

// Start begins polling; it is a no-op if already running.
func (s *Service) Start() error {
	s.runMu.Lock()
	defer s.runMu.Unlock()
	if s.cancel != nil {
		return nil
	}
	log.Info("Checking Cloudflare Stream live input")
	preflightCtx, cancelPreflight := context.WithTimeout(context.Background(), 4*time.Second)
	live, videoUID, retry, err := s.fetchLifecycle(preflightCtx)
	cancelPreflight()
	if err == nil {
		state := "offline"
		if live {
			state = "live"
		}
		log.Infof("Cloudflare Stream live input check succeeded; input is %s", state)
	}
	if errors.Is(err, errInvalidResponse) {
		return fmt.Errorf("invalid Cloudflare Stream configuration; check CLOUDFLARE_STREAM_LIVE_INPUT_ID, CLOUDFLARE_STREAM_CUSTOMER_CODE, and public unsigned access: %w", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.recordRefresh(ctx, &s.lifecycle, retry, err, "startup lifecycle")
	s.cancel = cancel
	s.done = make(chan struct{})
	go func() {
		defer close(s.done)
		if err == nil {
			s.applyLifecycle(live, videoUID)
		}
		timer := time.NewTimer(0)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				s.poll(ctx)
				timer.Reset(pollInterval)
			}
		}
	}()
	return nil
}

// Stop cancels polling and waits for the poller to exit. It never stops the
// encoder at Cloudflare.
func (s *Service) Stop() error {
	s.runMu.Lock()
	defer s.runMu.Unlock()
	if s.cancel != nil {
		s.cancel()
		<-s.done
		s.cancel = nil
	}
	return nil
}

func (s *Service) poll(ctx context.Context) {
	if ctx.Err() != nil {
		return
	}
	if s.refreshDue(&s.lifecycle) {
		s.refreshLifecycle(ctx)
	}
	s.mu.RLock()
	live := s.live
	s.mu.RUnlock()
	if live && ctx.Err() == nil && s.refreshDue(&s.views) {
		s.refreshViews(ctx)
	}
}

func (s *Service) refreshDue(state *refreshState) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return !s.now().Before(state.nextAttempt)
}

func (s *Service) refreshLifecycle(ctx context.Context) {
	live, videoUID, retry, err := s.fetchLifecycle(ctx)
	if s.recordRefresh(ctx, &s.lifecycle, retry, err, "lifecycle") {
		s.applyLifecycle(live, videoUID)
	}
}

func (s *Service) fetchLifecycle(ctx context.Context) (bool, string, time.Duration, error) {
	var response struct {
		IsInput  *bool   `json:"isInput"`
		Live     *bool   `json:"live"`
		VideoUID *string `json:"videoUID"`
	}
	retry, err := s.fetch(ctx, "lifecycle", &response)
	if err != nil {
		return false, "", retry, err
	}
	if response.IsInput == nil || !*response.IsInput || response.Live == nil || (response.VideoUID != nil && !validVideoID(*response.VideoUID)) {
		return false, "", 0, fmt.Errorf("%w: invalid lifecycle payload", errInvalidResponse)
	}
	videoUID := ""
	if *response.Live && response.VideoUID != nil {
		videoUID = *response.VideoUID
	}
	return *response.Live, videoUID, 0, nil
}

func (s *Service) applyLifecycle(live bool, videoUID string) {
	s.mu.Lock()
	wasLive := s.live
	// Only a change between two known UIDs is a new broadcast; a UID that
	// merely appears or disappears while live is the same session.
	newSession := wasLive && live && s.videoUID != "" && videoUID != "" && s.videoUID != videoUID
	s.live, s.videoUID = live, videoUID
	if !s.live || !wasLive || newSession {
		s.viewers = 0
		s.views = refreshState{}
	}
	s.mu.Unlock()
	if wasLive && (!live || newSession) {
		log.Info("Cloudflare Stream broadcast went offline")
		s.events.StreamDisconnected(nil)
	}
	if live && (!wasLive || newSession) {
		log.Info("Cloudflare Stream broadcast is live")
		s.events.StreamConnected(nil)
	}
}

func (s *Service) refreshViews(ctx context.Context) {
	var response struct {
		LiveViewers *int `json:"liveViewers"`
	}
	retry, err := s.fetch(ctx, "views", &response)
	if err == nil && (response.LiveViewers == nil || *response.LiveViewers < 0) {
		err = errors.New("invalid liveViewers count")
	}
	if !s.recordRefresh(ctx, &s.views, retry, err, "views") {
		return
	}
	s.mu.Lock()
	s.viewers = *response.LiveViewers
	s.mu.Unlock()
	s.events.ViewerCountUpdated(*response.LiveViewers)
}

func (s *Service) recordRefresh(ctx context.Context, state *refreshState, retry time.Duration, err error, endpoint string) bool {
	if ctx.Err() != nil {
		return false
	}
	s.mu.Lock()
	if err == nil {
		*state = refreshState{lastSuccess: s.now(), nextAttempt: s.now().Add(pollInterval)}
		s.mu.Unlock()
		return true
	}
	state.failures = min(state.failures+1, 5)
	delay := min(pollInterval*time.Duration(1<<state.failures), time.Minute)
	state.nextAttempt = s.now().Add(max(delay, retry))
	s.mu.Unlock()
	log.WithError(err).Warnf("Cloudflare Stream %s refresh failed; retry in %s (unauthenticated endpoint access required)", endpoint, max(delay, retry))
	return false
}

func (s *Service) fetch(ctx context.Context, endpoint string, output any) (time.Duration, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, s.endpoint(s.config.inputID, endpoint), nil)
	if err != nil {
		return 0, err
	}
	response, err := s.client.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		retry := retryAfter(response.Header.Get("Retry-After"), s.now())
		if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
			retry = max(retry, time.Minute)
		}
		err := fmt.Errorf("%s returned HTTP %d", endpoint, response.StatusCode)
		if response.StatusCode < http.StatusInternalServerError && response.StatusCode != http.StatusRequestTimeout && response.StatusCode != http.StatusTooManyRequests {
			err = fmt.Errorf("%w: %w", errInvalidResponse, err)
		}
		return retry, err
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil {
		return 0, err
	}
	if len(body) > 1<<20 {
		return 0, fmt.Errorf("%w: response exceeds size limit", errInvalidResponse)
	}
	if err := json.Unmarshal(body, output); err != nil {
		return 0, fmt.Errorf("%w: %w", errInvalidResponse, err)
	}
	return 0, nil
}

func retryAfter(value string, now time.Time) time.Duration {
	if seconds, err := strconv.Atoi(strings.TrimSpace(value)); err == nil && seconds > 0 {
		return time.Duration(min(int64(seconds), int64((1<<63-1)/time.Second))) * time.Second
	}
	if date, err := http.ParseTime(value); err == nil && date.After(now) {
		return date.Sub(now)
	}
	return 0
}
