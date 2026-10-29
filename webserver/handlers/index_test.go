package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/owncast/owncast/config"
	"github.com/owncast/owncast/services/activitypub"
	"github.com/owncast/owncast/services/activitypub/persistence/followersrepository"
	"github.com/owncast/owncast/services/stream"
)

func TestRequestAcceptsVideo(t *testing.T) {
	tests := []struct {
		name   string
		accept []string
		want   bool
	}{
		{
			name:   "video media type",
			accept: []string{"video/mp4"},
			want:   true,
		},
		{
			name:   "video wildcard with parameters",
			accept: []string{"text/html, video/*; q=0.5"},
			want:   true,
		},
		{
			name:   "HLS media type",
			accept: []string{"application/vnd.apple.mpegurl"},
			want:   true,
		},
		{
			name:   "legacy HLS media type",
			accept: []string{"application/x-mpegURL"},
			want:   true,
		},
		{
			name:   "separate video accept header",
			accept: []string{"text/html", "video/webm"},
			want:   true,
		},
		{
			name:   "unacceptable video media type",
			accept: []string{"video/mp4; q=0"},
			want:   false,
		},
		{
			name:   "invalid quality",
			accept: []string{"video/mp4; q=2"},
			want:   false,
		},
		{
			name:   "web media types",
			accept: []string{"text/html, application/xhtml+xml, image/avif"},
			want:   false,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			for _, accept := range test.accept {
				req.Header.Add("Accept", accept)
			}

			if got := requestAcceptsVideo(req); got != test.want {
				t.Errorf("requestAcceptsVideo() = %v, want %v", got, test.want)
			}
		})
	}
}

func TestIndexHandlerRedirectsVideoRequestToHLS(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Accept", "video/mp4")
	response := httptest.NewRecorder()

	(&Handlers{}).IndexHandler(response, req)

	if response.Code != http.StatusTemporaryRedirect {
		t.Errorf("status = %d, want %d", response.Code, http.StatusTemporaryRedirect)
	}
	if location := response.Header().Get("Location"); location != "/hls/stream.m3u8" {
		t.Errorf("Location = %q, want %q", location, "/hls/stream.m3u8")
	}
}

func TestCloudflareIframeConfigAndHydration(t *testing.T) {
	cfg := config.NewDefault()
	repo := testHandlers.configRepository
	h := NewHandlers(Deps{
		ConfigRepository: repo,
		Activitypub: activitypub.New(activitypub.Deps{
			Datastore:           testDatastore,
			ConfigRepository:    repo,
			FollowersRepository: followersrepository.New(testDatastore),
			Config:              cfg,
		}),
	})
	engine := &externalTestEngine{}
	var baseline map[string]any
	for _, test := range []struct {
		name   string
		stream *stream.Service
		url    string
	}{
		{name: "no stream"},
		{name: "local stream", stream: stream.New(stream.Deps{Config: cfg, ConfigRepository: repo})},
		{name: "external stream", stream: stream.New(stream.Deps{
			EngineFactory: func(stream.StreamEvents) stream.StreamEngine { return engine },
		}), url: engine.IframeURL()},
	} {
		t.Run(test.name, func(t *testing.T) {
			h.stream = test.stream
			request := httptest.NewRequest(http.MethodGet, "/api/config?token=private", nil)
			request.Header.Set("Authorization", "Bearer private")
			response := httptest.NewRecorder()
			h.GetWebConfig(response, request)
			var payload map[string]any
			if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
				t.Fatal(err)
			}
			iframeURL, present := payload["x_cloudflareStreamIframeUrl"]
			if test.url == "" {
				if present {
					t.Fatal("local/test configuration exposed iframe metadata")
				}
			} else if iframeURL != test.url {
				t.Fatalf("iframe metadata = %v, want %s", iframeURL, test.url)
			}
			delete(payload, "x_cloudflareStreamIframeUrl")
			if baseline == nil {
				baseline = payload
			} else if !reflect.DeepEqual(baseline, payload) {
				t.Fatal("external playback changed official configuration fields")
			}
			if test.url != "" {
				html := httptest.NewRecorder()
				h.renderIndexHtml(html, httptest.NewRequest(http.MethodGet, "/", nil), "test-nonce")
				if html.Code != http.StatusOK || !strings.Contains(html.Body.String(), test.url) || !strings.Contains(html.Body.String(), "x_cloudflareStreamIframeUrl") {
					t.Fatal("main page hydration lost iframe metadata")
				}
			}
		})
	}
}
