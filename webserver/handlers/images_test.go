package handlers

import (
	"bytes"
	"context"
	"image"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/owncast/owncast/persistence/configrepository"
	"github.com/owncast/owncast/services/datastore"
	"github.com/owncast/owncast/services/stream"
)

func previewTestHandlers(t *testing.T, handler http.HandlerFunc) (*Handlers, *externalTestEngine) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	ds, err := datastore.SetupPersistence(":memory:", os.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	engine := &externalTestEngine{thumbnail: server.URL + "/video/thumbnails/thumbnail.jpg"}
	h := NewHandlers(Deps{
		Stream:           stream.New(stream.Deps{EngineFactory: func(stream.StreamEvents) stream.StreamEngine { return engine }}),
		ThumbnailClient:  server.Client(),
		ConfigRepository: configrepository.New(ds),
	})
	return h, engine
}

func testJPEG(t *testing.T) []byte {
	t.Helper()
	var buffer bytes.Buffer
	if err := jpeg.Encode(&buffer, image.NewRGBA(image.Rect(0, 0, 2, 2)), nil); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func requestPreview(h *Handlers, path string) *httptest.ResponseRecorder {
	h.refreshExternalThumbnail(context.Background())
	writer := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, path, nil)
	request.Header.Set("Authorization", "Bearer do-not-forward")
	if strings.HasPrefix(path, "/preview.gif") {
		h.GetPreview(writer, request)
	} else {
		h.GetThumbnail(writer, request)
	}
	return writer
}

func TestThumbnailRequestDoesNotFetch(t *testing.T) {
	var requests atomic.Int32
	h, _ := previewTestHandlers(t, func(writer http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		_, _ = writer.Write(testJPEG(t))
	})
	writer := httptest.NewRecorder()
	h.GetThumbnail(writer, httptest.NewRequest(http.MethodGet, "/thumbnail.jpg", nil))
	if requests.Load() != 0 || writer.Header().Get("Content-Type") != contentTypePNG {
		t.Fatal("cold visitor request fetched from the provider instead of serving the logo")
	}
}

func TestThumbnailBackgroundRefresh(t *testing.T) {
	data := testJPEG(t)
	var requests atomic.Int32
	stalled := make(chan struct{})
	h, engine := previewTestHandlers(t, func(writer http.ResponseWriter, request *http.Request) {
		if requests.Add(1) == 1 {
			_, _ = writer.Write(data)
			return
		}
		close(stalled)
		<-request.Context().Done()
	})
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	done := make(chan struct{})
	go func() {
		defer close(done)
		h.RunThumbnailRefresh(ctx)
	}()
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	poll := time.NewTicker(5 * time.Millisecond)
	defer poll.Stop()
	for !bytes.Equal(h.externalThumbnail(), data) {
		select {
		case <-deadline.C:
			t.Fatal("background worker did not fetch without visitor requests")
		case <-poll.C:
		}
	}
	h.previewThumbCache.Set(engine.ThumbnailURL(), data, time.Nanosecond)
	select {
	case <-stalled:
	case <-deadline.C:
		t.Fatal("background worker did not refresh the expired thumbnail")
	}
	response := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		writer := httptest.NewRecorder()
		h.GetPreview(writer, httptest.NewRequest(http.MethodGet, "/preview.gif", nil))
		response <- writer
	}()
	select {
	case writer := <-response:
		if !bytes.Equal(writer.Body.Bytes(), data) {
			t.Fatal("visitor did not receive the last good image during a stalled refresh")
		}
	case <-time.After(time.Second):
		t.Fatal("visitor request blocked on the provider refresh")
	}
	engine.mu.Lock()
	engine.thumbnail = ""
	engine.mu.Unlock()
	if h.externalThumbnail() != nil {
		t.Fatal("offline input still served the previous thumbnail")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("cancellation did not stop the in-flight refresh")
	}
	if requests.Load() != 2 {
		t.Fatal("visitor requests caused extra provider fetches")
	}
}

func TestThumbnailPreviewSharedCache(t *testing.T) {
	data := testJPEG(t)
	var requests atomic.Int32
	h, engine := previewTestHandlers(t, func(writer http.ResponseWriter, request *http.Request) {
		requests.Add(1)
		validPath := request.URL.Path == "/video/thumbnails/thumbnail.jpg" || request.URL.Path == "/new-video/thumbnails/thumbnail.jpg"
		if !validPath || request.URL.RawQuery != "" || request.Header.Get("Authorization") != "" {
			t.Error("thumbnail proxy forwarded query/auth or used a GIF/status endpoint")
		}
		writer.Header().Set("Set-Cookie", "private=value")
		_, _ = writer.Write(data)
	})
	var clients sync.WaitGroup
	for index := range 20 {
		clients.Go(func() {
			path := "/thumbnail.jpg?cb=" + strconv.Itoa(index)
			if index%2 == 0 {
				path = "/preview.gif?cb=" + strconv.Itoa(index)
			}
			writer := requestPreview(h, path)
			if !bytes.Equal(writer.Body.Bytes(), data) || writer.Header().Get("Content-Type") != contentTypeJPEG || writer.Header().Get("Cache-Control") != "public, max-age=20" {
				t.Error("thumbnail and preview must return the same JPEG with max-age=20")
			}
			if writer.Header().Get("Set-Cookie") != "" {
				t.Error("proxy leaked provider headers")
			}
		})
	}
	clients.Wait()
	if requests.Load() != 1 {
		t.Fatalf("cold concurrent requests caused %d refreshes", requests.Load())
	}
	item := h.previewThumbCache.Get(engine.ThumbnailURL())
	if item.TTL() != 15*time.Second {
		t.Fatal("preview TTL is not 15 seconds")
	}
	expires := item.ExpiresAt()
	_ = requestPreview(h, "/preview.gif?cb=again")
	if !h.previewThumbCache.Get(engine.ThumbnailURL()).ExpiresAt().Equal(expires) {
		t.Fatal("cache hit extended the non-sliding TTL")
	}
	h.previewThumbCache.Set(engine.ThumbnailURL(), data, time.Nanosecond)
	for range 20 {
		clients.Go(func() { _ = requestPreview(h, "/preview.gif?cb=expired") })
	}
	clients.Wait()
	if requests.Load() != 2 {
		t.Fatalf("expired cache caused %d total refreshes, want 2", requests.Load())
	}
	engine.mu.Lock()
	engine.thumbnail = strings.Replace(engine.thumbnail, "/video/", "/new-video/", 1)
	engine.mu.Unlock()
	_ = requestPreview(h, "/thumbnail.jpg")
	if requests.Load() != 3 {
		t.Fatal("new video identity reused the old image")
	}
	engine.mu.Lock()
	engine.thumbnail = ""
	engine.mu.Unlock()
	writer := requestPreview(h, "/preview.gif")
	if bytes.Equal(writer.Body.Bytes(), data) || writer.Header().Get("Cache-Control") != "public, max-age=20" || writer.Header().Get("Content-Type") != "image/png" {
		t.Fatal("offline preview did not bypass cached live image with a correctly typed logo")
	}
}

func TestThumbnailPreviewFailureCache(t *testing.T) {
	for _, failure := range []string{"status", "html", "oversized", "redirect", "bad-jpeg"} {
		t.Run(failure, func(t *testing.T) {
			var requests atomic.Int32
			h, engine := previewTestHandlers(t, func(writer http.ResponseWriter, _ *http.Request) {
				requests.Add(1)
				switch failure {
				case "status":
					writer.WriteHeader(http.StatusServiceUnavailable)
				case "redirect":
					writer.Header().Set("Location", "http://127.0.0.1/private")
					writer.WriteHeader(http.StatusFound)
				case "oversized":
					_, _ = writer.Write(bytes.Repeat([]byte("x"), maxThumbnailBytes+1))
				case "bad-jpeg":
					_, _ = writer.Write([]byte{0xff, 0xd8, 0xff, 0xd9})
				default:
					_, _ = writer.Write([]byte("<html>upstream error</html>"))
				}
			})
			for _, path := range []string{"/thumbnail.jpg?cb=1", "/preview.gif?cb=2", "/thumbnail.jpg?cb=3"} {
				writer := requestPreview(h, path)
				if writer.Header().Get("Content-Type") != "image/png" || writer.Header().Get("Cache-Control") != "public, max-age=20" || bytes.Contains(writer.Body.Bytes(), []byte("upstream error")) {
					t.Fatal("failure response leaked provider content or lost fallback headers")
				}
			}
			if requests.Load() != 1 || h.previewThumbCache.Get(engine.ThumbnailURL()).TTL() != previewCacheTTL {
				t.Fatal("failed refresh was not cached for 15 seconds")
			}
			h.previewThumbCache.Set(engine.ThumbnailURL(), nil, time.Nanosecond)
			_ = requestPreview(h, "/preview.gif")
			if requests.Load() != 2 {
				t.Fatal("expired failed refresh did not retry exactly once")
			}
		})
	}
}

func TestThumbnailRetainsLastSuccessOnRefreshFailure(t *testing.T) {
	data := testJPEG(t)
	var fail atomic.Bool
	var requests atomic.Int32
	h, engine := previewTestHandlers(t, func(writer http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		if fail.Load() {
			writer.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_, _ = writer.Write(data)
	})
	if writer := requestPreview(h, "/thumbnail.jpg"); !bytes.Equal(writer.Body.Bytes(), data) {
		t.Fatal("initial thumbnail fetch failed")
	}
	fail.Store(true)
	for range 2 {
		h.previewThumbCache.Set(engine.ThumbnailURL(), nil, time.Nanosecond)
		for _, path := range []string{"/thumbnail.jpg", "/preview.gif"} {
			writer := requestPreview(h, path)
			if !bytes.Equal(writer.Body.Bytes(), data) || writer.Header().Get("Content-Type") != contentTypeJPEG {
				t.Fatal("refresh failure discarded the last successful thumbnail")
			}
		}
	}
	if requests.Load() != 3 {
		t.Fatal("failed refresh did not preserve the retry cache window")
	}
	engine.mu.Lock()
	engine.thumbnail = strings.Replace(engine.thumbnail, "/video/", "/new-video/", 1)
	engine.mu.Unlock()
	if writer := requestPreview(h, "/thumbnail.jpg"); bytes.Equal(writer.Body.Bytes(), data) {
		t.Fatal("new video reused the preceding broadcast's thumbnail")
	}
	engine.mu.Lock()
	engine.thumbnail = ""
	engine.mu.Unlock()
	if writer := requestPreview(h, "/preview.gif"); bytes.Equal(writer.Body.Bytes(), data) {
		t.Fatal("offline preview reused a live thumbnail")
	}
}

func TestThumbnailRetainsLastSuccessOnTimeout(t *testing.T) {
	data := testJPEG(t)
	var stall atomic.Bool
	h, engine := previewTestHandlers(t, func(writer http.ResponseWriter, request *http.Request) {
		if stall.Load() {
			<-request.Context().Done()
			return
		}
		_, _ = writer.Write(data)
	})
	if writer := requestPreview(h, "/thumbnail.jpg"); !bytes.Equal(writer.Body.Bytes(), data) {
		t.Fatal("initial thumbnail fetch failed")
	}
	stall.Store(true)
	h.thumbnailClient.Timeout = 50 * time.Millisecond
	h.previewThumbCache.Set(engine.ThumbnailURL(), nil, time.Nanosecond)
	if writer := requestPreview(h, "/preview.gif"); !bytes.Equal(writer.Body.Bytes(), data) {
		t.Fatal("timed-out refresh discarded the last successful thumbnail")
	}
}

func TestThumbnailDiscardsChangedIdentityDuringRefresh(t *testing.T) {
	for _, transition := range []string{"offline", "new-video"} {
		t.Run(transition, func(t *testing.T) {
			data := testJPEG(t)
			entered, release := make(chan struct{}), make(chan struct{})
			h, engine := previewTestHandlers(t, func(writer http.ResponseWriter, request *http.Request) {
				if strings.HasPrefix(request.URL.Path, "/video/") {
					close(entered)
					<-release
				}
				_, _ = writer.Write(data)
			})
			t.Cleanup(func() {
				select {
				case <-release:
				default:
					close(release)
				}
			})
			oldSource := engine.ThumbnailURL()
			result := make(chan *httptest.ResponseRecorder, 1)
			go func() { result <- requestPreview(h, "/preview.gif") }()
			select {
			case <-entered:
			case <-time.After(2 * time.Second):
				t.Fatal("thumbnail fetch did not start")
			}
			engine.mu.Lock()
			engine.thumbnail = ""
			if transition == "new-video" {
				engine.thumbnail = strings.Replace(oldSource, "/video/", "/new-video/", 1)
			}
			engine.mu.Unlock()
			close(release)
			select {
			case writer := <-result:
				if bytes.Equal(writer.Body.Bytes(), data) || writer.Header().Get("Cache-Control") != "public, max-age=20" {
					t.Fatal("identity change served the preceding broadcast's in-flight image")
				}
			case <-time.After(2 * time.Second):
				t.Fatal("thumbnail request did not complete")
			}
			if h.previewThumbCache.Get(oldSource) != nil {
				t.Fatal("identity change cached the old broadcast image")
			}
		})
	}
}
