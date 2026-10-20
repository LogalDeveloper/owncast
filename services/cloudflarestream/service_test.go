package cloudflarestream

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/owncast/owncast/models"
)

const (
	inputID = "0123456789abcdef0123456789abcdef"
	videoID = "abcdef0123456789abcdef0123456789"
)

type events struct {
	connected    int
	disconnected int
	counts       []int
	broadcast    *models.CurrentBroadcast
}

func (e *events) StreamConnected(broadcast *models.CurrentBroadcast) {
	e.broadcast = broadcast
	e.connected++
}

func (e *events) StreamDisconnected(error)          { e.disconnected++ }
func (e *events) BroadcasterSet(models.Broadcaster) {}
func (e *events) ViewerCountUpdated(count int)      { e.counts = append(e.counts, count) }

func testService(t *testing.T, handler http.HandlerFunc) (*Service, *events) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	baseURL, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	callbacks := &events{}
	service := New(Deps{Config: Config{baseURL: baseURL, inputID: inputID}, Client: server.Client(), Events: callbacks})
	return service, callbacks
}

func TestConfigAndPlayback(t *testing.T) {
	for _, value := range []string{"", " ", "../bad", "not-an-id"} {
		if _, err := NewConfig(value, "customer"); err == nil {
			t.Fatalf("accepted invalid input %q", value)
		}
	}
	for _, value := range []string{"", " ", "evil.com/path", "x:443", "-bad", strings.Repeat("a", 55)} {
		if _, err := NewConfig(inputID, value); err == nil {
			t.Fatalf("accepted invalid customer code %q", value)
		}
	}
	config, err := NewConfig(inputID, "abc123")
	if err != nil {
		t.Fatal(err)
	}
	service := New(Deps{Config: config, Client: &http.Client{}, Events: &events{}})
	want := "https://customer-abc123.cloudflarestream.com/" + inputID + "/manifest/video.m3u8"
	if service.PlaybackURL() != want || service.ViewerCount() != 0 || service.ThumbnailURL() != "" {
		t.Fatal("incorrect default state or standard HLS URL")
	}
}

func TestStartValidatesLifecycle(t *testing.T) {
	tests := []struct {
		name    string
		status  int
		body    string
		wantErr bool
	}{
		{name: "offline input", status: http.StatusOK, body: `{"isInput":true,"live":false,"videoUID":null}`},
		{name: "missing input", status: http.StatusNotFound, wantErr: true},
		{name: "invalid request", status: http.StatusBadRequest, wantErr: true},
		{name: "authentication required", status: http.StatusUnauthorized, wantErr: true},
		{name: "access forbidden", status: http.StatusForbidden, wantErr: true},
		{name: "redirect", status: http.StatusFound, wantErr: true},
		{name: "not an input", status: http.StatusOK, body: `{"isInput":false,"live":false}`, wantErr: true},
		{name: "missing input flag", status: http.StatusOK, body: `{"live":false}`, wantErr: true},
		{name: "null input flag", status: http.StatusOK, body: `{"isInput":null,"live":false}`, wantErr: true},
		{name: "missing live flag", status: http.StatusOK, body: `{"isInput":true}`, wantErr: true},
		{name: "null live flag", status: http.StatusOK, body: `{"isInput":true,"live":null}`, wantErr: true},
		{name: "invalid live flag", status: http.StatusOK, body: `{"isInput":true,"live":"false"}`, wantErr: true},
		{name: "invalid video UID", status: http.StatusOK, body: `{"isInput":true,"live":true,"videoUID":"bad"}`, wantErr: true},
		{name: "empty response", status: http.StatusOK, wantErr: true},
		{name: "malformed JSON", status: http.StatusOK, body: `broken`, wantErr: true},
		{name: "trailing JSON", status: http.StatusOK, body: `{"isInput":true,"live":false} {}`, wantErr: true},
		{name: "request timeout", status: http.StatusRequestTimeout},
		{name: "rate limited", status: http.StatusTooManyRequests},
		{name: "server error", status: http.StatusInternalServerError},
		{name: "unavailable", status: http.StatusServiceUnavailable},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var requests atomic.Int32
			service, _ := testService(t, func(writer http.ResponseWriter, request *http.Request) {
				requests.Add(1)
				if request.URL.Path != "/"+inputID+"/lifecycle" {
					t.Errorf("unexpected startup endpoint: %s", request.URL.Path)
				}
				writer.WriteHeader(test.status)
				_, _ = writer.Write([]byte(test.body))
			})
			t.Cleanup(func() { _ = service.Stop() })
			err := service.Start()
			if (err != nil) != test.wantErr {
				t.Fatalf("Start() error = %v, want error %t", err, test.wantErr)
			}
			if test.wantErr && !strings.Contains(err.Error(), "CLOUDFLARE_STREAM_LIVE_INPUT_ID") {
				t.Fatalf("startup error lacks configuration guidance: %v", err)
			}
			if err := service.Stop(); err != nil {
				t.Fatal(err)
			}
			if requests.Load() != 1 {
				t.Fatalf("expected one startup lifecycle request, got %d", requests.Load())
			}
		})
	}
}

func TestStartTimeoutIsRetryable(t *testing.T) {
	service, callbacks := testService(t, func(_ http.ResponseWriter, request *http.Request) {
		<-request.Context().Done()
	})
	service.client.Timeout = 10 * time.Millisecond
	if err := service.Start(); err != nil {
		t.Fatalf("startup failed on a transient timeout: %v", err)
	}
	if err := service.Stop(); err != nil {
		t.Fatal(err)
	}
	if service.lifecycle.failures != 1 || callbacks.connected != 0 {
		t.Fatal("startup timeout did not preserve offline state and schedule a retry")
	}
}

func TestStartReusesLivePreflight(t *testing.T) {
	var lifecycleRequests atomic.Int32
	viewsRequested := make(chan struct{})
	service, callbacks := testService(t, func(writer http.ResponseWriter, request *http.Request) {
		if strings.HasSuffix(request.URL.Path, "/lifecycle") {
			lifecycleRequests.Add(1)
			_, _ = writer.Write([]byte(`{"isInput":true,"live":true,"videoUID":"` + videoID + `"}`))
			return
		}
		close(viewsRequested)
		_, _ = writer.Write([]byte(`{"liveViewers":0}`))
	})
	t.Cleanup(func() { _ = service.Stop() })
	if err := service.Start(); err != nil {
		t.Fatal(err)
	}
	if err := service.Start(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-viewsRequested:
	case <-time.After(2 * time.Second):
		t.Fatal("live preflight did not trigger viewer polling")
	}
	if err := service.Stop(); err != nil {
		t.Fatal(err)
	}
	if lifecycleRequests.Load() != 1 || callbacks.connected != 1 || !strings.Contains(service.ThumbnailURL(), videoID) {
		t.Fatal("startup did not reuse the initial lifecycle sample")
	}
}

func TestStartAfterRejectedPreflight(t *testing.T) {
	var requests atomic.Int32
	service, _ := testService(t, func(writer http.ResponseWriter, _ *http.Request) {
		if requests.Add(1) == 1 {
			writer.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = writer.Write([]byte(`{"isInput":true,"live":false}`))
	})
	t.Cleanup(func() { _ = service.Stop() })
	if err := service.Start(); err == nil {
		t.Fatal("startup accepted an unknown input")
	}
	if service.cancel != nil {
		t.Fatal("rejected preflight left the poller running")
	}
	if err := service.Start(); err != nil {
		t.Fatalf("startup could not recover after a rejected preflight: %v", err)
	}
}

func TestLifecycleCountsAndSessions(t *testing.T) {
	live, uid, count := true, videoID, `{"liveViewers":17}`
	lifecycleStatus := http.StatusOK
	service, callbacks := testService(t, func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "" || request.URL.RawQuery != "" {
			t.Error("provider request leaked credentials or query parameters")
		}
		switch request.URL.Path {
		case "/" + inputID + "/lifecycle":
			writer.WriteHeader(lifecycleStatus)
			_, _ = fmt.Fprintf(writer, `{"isInput":true,"live":%t,"videoUID":%q}`, live, uid)
		case "/" + inputID + "/views":
			_, _ = writer.Write([]byte(count))
		default:
			t.Errorf("unexpected endpoint: %s", request.URL)
		}
	})
	now := time.Now()
	service.now = func() time.Time { return now }
	poll := func() { service.poll(context.Background()); now = now.Add(time.Minute) }
	poll()
	poll()
	if callbacks.broadcast != nil || callbacks.connected != 1 || service.ViewerCount() != 17 || !strings.Contains(service.ThumbnailURL(), videoID) {
		t.Fatal("live state, cached identity, or event deduplication failed")
	}
	for _, invalid := range []string{`{}`, `{"liveViewers":-1}`, `{"liveViewers":"2"}`, `{"liveViewers":null}`, `broken`} {
		count = invalid
		poll()
		if service.ViewerCount() != 17 {
			t.Fatal("malformed count overwrote last successful sample")
		}
	}
	lifecycleStatus, count = http.StatusInternalServerError, `{"liveViewers":0}`
	poll()
	if service.ViewerCount() != 0 || callbacks.disconnected != 0 {
		t.Fatal("lifecycle failure suppressed independent valid zero sample")
	}
	lifecycleStatus, count = http.StatusOK, `{"liveViewers":9}`
	uid = inputID
	count = `broken`
	poll()
	if service.ViewerCount() != 0 || callbacks.connected != 2 || callbacks.disconnected != 1 || !strings.Contains(service.ThumbnailURL(), inputID) {
		t.Fatal("new broadcast identity did not start a new session")
	}
	count = `{"liveViewers":9}`
	poll()
	live, count = false, `broken`
	poll()
	poll()
	if callbacks.disconnected != 2 || service.ViewerCount() != 0 || service.ThumbnailURL() != "" {
		t.Fatal("offline state did not clear cached count/image or deduplicate events")
	}
}

func TestMalformedLifecycleRetainsState(t *testing.T) {
	lifecycle := `{"isInput":true,"live":true,"videoUID":"` + videoID + `"}`
	service, callbacks := testService(t, func(writer http.ResponseWriter, request *http.Request) {
		body := `{"liveViewers":5}`
		if strings.HasSuffix(request.URL.Path, "/lifecycle") {
			body = lifecycle
		}
		_, _ = writer.Write([]byte(body))
	})
	now := time.Now()
	service.now = func() time.Time { return now }
	service.poll(context.Background())
	for _, invalid := range []string{`{}`, `{"isInput":false,"live":false}`, `{"isInput":true,"live":null}`, `{"isInput":true,"live":"false"}`, `{"isInput":true,"live":true,"videoUID":"../outside"}`, `broken`} {
		now = now.Add(time.Minute)
		lifecycle = invalid
		service.poll(context.Background())
		if callbacks.connected != 1 || callbacks.disconnected != 0 || service.ViewerCount() != 5 || service.ThumbnailURL() == "" {
			t.Fatal("malformed lifecycle erased last-known state")
		}
	}
}

func TestAuthRejectionAndBackoff(t *testing.T) {
	service, _ := testService(t, func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusUnauthorized)
	})
	now := time.Now()
	service.now = func() time.Time { return now }
	service.poll(context.Background())
	if !service.lifecycle.nextAttempt.Equal(now.Add(time.Minute)) {
		t.Fatal("auth rejection did not use slower retry")
	}
	state := refreshState{}
	for range 10 {
		service.recordRefresh(context.Background(), &state, 0, context.DeadlineExceeded, "test")
	}
	if !state.nextAttempt.Equal(now.Add(time.Minute)) {
		t.Fatal("exponential backoff was not capped at one minute")
	}
	if retryAfter(now.Add(90*time.Second).UTC().Format(http.TimeFormat), now.Truncate(time.Second)) != 90*time.Second {
		t.Fatal("HTTP-date Retry-After was not parsed")
	}
	if retryAfter("172800", now) != 48*time.Hour {
		t.Fatal("long Retry-After was truncated")
	}
}

func TestRequestTimeout(t *testing.T) {
	service, callbacks := testService(t, func(_ http.ResponseWriter, request *http.Request) {
		<-request.Context().Done()
	})
	service.client.Timeout = 10 * time.Millisecond
	service.poll(context.Background())
	if service.lifecycle.failures != 1 || callbacks.connected != 0 || service.ViewerCount() != 0 {
		t.Fatal("timeout did not retain offline/zero defaults with backoff")
	}
}

func TestRetryAndCachedConcurrentReads(t *testing.T) {
	requests, status := 0, http.StatusTooManyRequests
	service, _ := testService(t, func(writer http.ResponseWriter, _ *http.Request) {
		requests++
		writer.Header().Set("Retry-After", "90")
		writer.WriteHeader(status)
		_, _ = writer.Write([]byte(`{"isInput":true,"live":false,"videoUID":null}`))
	})
	now := time.Now()
	service.now = func() time.Time { return now }
	service.poll(context.Background())
	now = now.Add(89 * time.Second)
	service.poll(context.Background())
	if requests != 1 {
		t.Fatal("Retry-After was ignored")
	}
	now = now.Add(time.Second)
	status = http.StatusOK
	service.poll(context.Background())
	if service.lifecycle.failures != 0 || !service.lifecycle.nextAttempt.Equal(now.Add(pollInterval)) {
		t.Fatal("successful refresh did not reset backoff")
	}
	var readers sync.WaitGroup
	for range 20 {
		readers.Go(func() {
			for range 100 {
				_ = service.ViewerCount()
				_ = service.ThumbnailURL()
				_ = service.PlaybackURL()
			}
		})
	}
	readers.Wait()
	if requests != 2 {
		t.Fatal("cached accessors performed I/O")
	}
}

func TestStopCancelsRequest(t *testing.T) {
	entered := make(chan struct{})
	service, _ := testService(t, func(writer http.ResponseWriter, request *http.Request) {
		if strings.HasSuffix(request.URL.Path, "/lifecycle") {
			_, _ = writer.Write([]byte(`{"isInput":true,"live":true,"videoUID":"` + videoID + `"}`))
			return
		}
		close(entered)
		<-request.Context().Done()
	})
	if err := service.Start(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("poll did not start immediately")
	}
	if err := service.Stop(); err != nil {
		t.Fatal(err)
	}
	if err := service.Stop(); err != nil {
		t.Fatal(err)
	}
}

func TestCachedReadsDuringRefresh(t *testing.T) {
	service, _ := testService(t, func(writer http.ResponseWriter, request *http.Request) {
		body := `{"liveViewers":7}`
		if strings.HasSuffix(request.URL.Path, "/lifecycle") {
			body = `{"isInput":true,"live":true,"videoUID":"` + videoID + `"}`
		}
		_, _ = writer.Write([]byte(body))
	})
	var readers sync.WaitGroup
	for range 4 {
		readers.Go(func() {
			for range 1000 {
				_ = service.ViewerCount()
				_ = service.ThumbnailURL()
				_ = service.PlaybackURL()
			}
		})
	}
	for range 8 {
		service.refreshLifecycle(context.Background())
		service.refreshViews(context.Background())
	}
	readers.Wait()
	if service.ViewerCount() != 7 || service.ThumbnailURL() == "" {
		t.Fatal("concurrent cached reads corrupted provider state")
	}
}
