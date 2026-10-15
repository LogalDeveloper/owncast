package admin

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/owncast/owncast/config"
	"github.com/owncast/owncast/models"
	"github.com/owncast/owncast/persistence/configrepository"
	"github.com/owncast/owncast/services/stream"
)

type remoteTestEngine struct{ stopped bool }

func (*remoteTestEngine) Start() error  { return nil }
func (e *remoteTestEngine) Stop() error { e.stopped = true; return nil }
func (*remoteTestEngine) PlaybackURL() string {
	return "https://example.com/manifest/video.m3u8?protocol=llhls"
}
func (*remoteTestEngine) ViewerCount() int     { return 0 }
func (*remoteTestEngine) ThumbnailURL() string { return "" }

func TestCloudflareAdminConfiguration(t *testing.T) {
	engine := &remoteTestEngine{}
	repo := configrepository.New(testDatastore)
	a := New(Deps{ConfigRepository: repo, Config: config.NewDefault(), Stream: stream.New(stream.Deps{
		EngineFactory: func(stream.StreamEvents) stream.StreamEngine { return engine },
	})})
	writer := httptest.NewRecorder()
	a.GetServerConfig(writer, httptest.NewRequest(http.MethodGet, "/api/admin/serverconfig", nil))
	var response serverConfigAdminResponse
	if err := json.Unmarshal(writer.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.FFmpegPath != "" || response.SupportedCodecs == nil || len(response.SupportedCodecs) != 0 {
		t.Fatal("remote admin config did not preserve empty FFmpeg/codec fields")
	}
	writer = httptest.NewRecorder()
	a.DisconnectInboundConnection(writer, httptest.NewRequest(http.MethodPost, "/api/admin/disconnect", nil))
	if parseResponse(t, writer).Success || engine.stopped {
		t.Fatal("unsupported disconnect reported success or stopped the provider poller")
	}
	writer = httptest.NewRecorder()
	a.SetFfmpegPath(writer, httptest.NewRequest(http.MethodPost, "/api/admin/config/ffmpegpath", strings.NewReader(`{"value":"/nonexistent/ffmpeg"}`)))
	result := parseResponse(t, writer)
	if result.Success || !strings.Contains(result.Message, "inactive") {
		t.Fatal("remote admin FFmpeg setter attempted a process probe")
	}
}

func TestSetAutoplayValidValues(t *testing.T) {
	configRepository := configrepository.New(testDatastore)

	for _, value := range []models.AutoplayMode{models.AutoplayOff, models.AutoplayAlways, models.AutoplaySoundOnly} {
		body := makeConfigValueBody(string(value))
		req := httptest.NewRequest(http.MethodPost, "/api/admin/config/autoplay", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()

		testAdmin.SetAutoplay(w, req)

		resp := parseResponse(t, w)
		if !resp.Success {
			t.Fatalf("value %q: expected success, got error: %s", value, resp.Message)
		}
		if got := configRepository.GetAutoplay(); got != value {
			t.Errorf("value %q: expected persisted autoplay %q, got %q", value, value, got)
		}
	}
}

func TestSetAutoplayRejectsInvalidValue(t *testing.T) {
	configRepository := configrepository.New(testDatastore)

	// Set a known-good value so we can confirm a rejected set leaves it unchanged.
	good := httptest.NewRequest(
		http.MethodPost,
		"/api/admin/config/autoplay",
		strings.NewReader(makeConfigValueBody(string(models.AutoplayAlways))),
	)
	good.Header.Set("Content-Type", "application/json")
	testAdmin.SetAutoplay(httptest.NewRecorder(), good)

	req := httptest.NewRequest(http.MethodPost, "/api/admin/config/autoplay", strings.NewReader(makeConfigValueBody("bogus")))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	testAdmin.SetAutoplay(w, req)

	resp := parseResponse(t, w)
	if resp.Success {
		t.Fatal("expected failure for an invalid autoplay value")
	}
	if resp.Message != "invalid autoplay value" {
		t.Errorf("expected message 'invalid autoplay value', got %q", resp.Message)
	}
	if got := configRepository.GetAutoplay(); got != models.AutoplayAlways {
		t.Errorf("expected autoplay to stay 'always' after a rejected set, got %q", got)
	}
}

func TestSetAutoplayRejectsNonStringValue(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/admin/config/autoplay", strings.NewReader(`{"value": true}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	testAdmin.SetAutoplay(w, req)

	resp := parseResponse(t, w)
	if resp.Success {
		t.Fatal("expected failure for a non-string autoplay value")
	}
}

func TestSetAutoplayRejectsGETMethod(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/admin/config/autoplay", nil)
	w := httptest.NewRecorder()

	testAdmin.SetAutoplay(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected status 400 for a GET request, got %d", w.Code)
	}
}
