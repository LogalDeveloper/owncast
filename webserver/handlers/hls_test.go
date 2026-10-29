package handlers

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/owncast/owncast/config"
	"github.com/owncast/owncast/services/stream"
)

type externalTestEngine struct {
	mu        sync.RWMutex
	thumbnail string
}

func (*externalTestEngine) Start() error     { return nil }
func (*externalTestEngine) Stop() error      { return nil }
func (*externalTestEngine) ViewerCount() int { return 0 }
func (*externalTestEngine) PlaybackURL() string {
	return "https://customer-code.cloudflarestream.com/0123456789abcdef0123456789abcdef/manifest/video.m3u8"
}

func (*externalTestEngine) IframeURL() string {
	return "https://customer-code.cloudflarestream.com/0123456789abcdef0123456789abcdef/iframe"
}

func (e *externalTestEngine) ThumbnailURL() string {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.thumbnail
}

func TestExternalHLSRedirect(t *testing.T) {
	engine := &externalTestEngine{}
	h := NewHandlers(Deps{Stream: stream.New(stream.Deps{EngineFactory: func(stream.StreamEvents) stream.StreamEngine {
		return engine
	}})})
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		request := httptest.NewRequest(method, "/hls/stream.m3u8?token=secret&protocol=llhls", nil)
		request.Header.Set("Authorization", "Bearer private")
		writer := httptest.NewRecorder()
		h.HandleHLSRequest(writer, request)
		if writer.Code != http.StatusFound || writer.Header().Get("Location") != engine.PlaybackURL() {
			t.Fatalf("%s: expected fixed standard HLS redirect, got %d %s", method, writer.Code, writer.Header().Get("Location"))
		}
		if writer.Header().Get("Access-Control-Allow-Origin") != "*" || !strings.Contains(writer.Header().Get("Cache-Control"), "no-cache") {
			t.Fatal("redirect lost CORS or no-cache headers")
		}
		if writer.Header().Get("Authorization") != "" {
			t.Fatal("redirect forwarded authorization")
		}
	}
	for _, path := range []string{"/hls/0/stream.m3u8", "/hls/segment.ts", "/hls/../stream.m3u8", "/hls/x/../stream.m3u8", "/other/stream.m3u8"} {
		writer := httptest.NewRecorder()
		h.HandleHLSRequest(writer, httptest.NewRequest(http.MethodGet, path, nil))
		if writer.Code != http.StatusNotFound {
			t.Fatalf("%s: expected 404, got %d", path, writer.Code)
		}
	}
}

func TestHandleHLSRequestRejectsPathTraversal(t *testing.T) {
	originalStoragePath := config.HLSStoragePath
	config.HLSStoragePath = filepath.Join(t.TempDir(), "hls")
	t.Cleanup(func() {
		config.HLSStoragePath = originalStoragePath
	})

	r := httptest.NewRequest(http.MethodGet, "/hls/../outside.ts", nil)
	w := httptest.NewRecorder()

	(&Handlers{}).HandleHLSRequest(w, r)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d", http.StatusNotFound, w.Code)
	}
}
