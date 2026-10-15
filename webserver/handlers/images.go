package handlers

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image/jpeg"
	"io"
	"net/http"
	"path/filepath"
	"time"

	log "github.com/sirupsen/logrus"

	"github.com/owncast/owncast/config"
	"github.com/owncast/owncast/static"
	"github.com/owncast/owncast/utils"
)

const (
	contentTypeJPEG = "image/jpeg"
	contentTypeGIF  = "image/gif"
	contentTypePNG  = "image/png"

	thumbnailFilename = "thumbnail.jpg"
	previewCacheTTL   = 15 * time.Second
	maxThumbnailBytes = 5 << 20
)

// GetThumbnail will return the thumbnail image as a response.
func (h *Handlers) GetThumbnail(w http.ResponseWriter, r *http.Request) {
	if h.stream != nil && h.stream.HasExternalPlayback() {
		h.getExternalPreview(w)
		return
	}
	imageFilename := thumbnailFilename
	imagePath := filepath.Join(h.cfg.TempDir, imageFilename)
	httpCacheTime := utils.GetCacheDurationSecondsForPath(imagePath)
	inMemoryCacheTime := time.Duration(15) * time.Second

	var imageBytes []byte
	var err error

	if h.previewThumbCache.Get(imagePath) != nil {
		ci := h.previewThumbCache.Get(imagePath)
		imageBytes = ci.Value()
	} else if utils.DoesFileExists(imagePath) {
		imageBytes, err = getImage(imagePath)
		h.previewThumbCache.Set(imagePath, imageBytes, inMemoryCacheTime)
	} else {
		h.GetLogo(w, r)
		return
	}

	if err != nil {
		h.GetLogo(w, r)
		return
	}

	writeBytesAsImage(imageBytes, contentTypeJPEG, w, httpCacheTime)
}

// GetPreview will return the preview gif as a response.
func (h *Handlers) GetPreview(w http.ResponseWriter, r *http.Request) {
	if h.stream != nil && h.stream.HasExternalPlayback() {
		h.getExternalPreview(w)
		return
	}
	imageFilename := "preview.gif"
	imagePath := filepath.Join(h.cfg.TempDir, imageFilename)
	httpCacheTime := utils.GetCacheDurationSecondsForPath(imagePath)
	inMemoryCacheTime := time.Duration(15) * time.Second

	var imageBytes []byte
	var err error

	if h.previewThumbCache.Get(imagePath) != nil {
		ci := h.previewThumbCache.Get(imagePath)
		imageBytes = ci.Value()
	} else if utils.DoesFileExists(imagePath) {
		imageBytes, err = getImage(imagePath)
		h.previewThumbCache.Set(imagePath, imageBytes, inMemoryCacheTime)
	} else {
		h.GetLogo(w, r)
		return
	}

	if err != nil {
		h.GetLogo(w, r)
		return
	}

	writeBytesAsImage(imageBytes, contentTypeGIF, w, httpCacheTime)
}

func (h *Handlers) getExternalPreview(w http.ResponseWriter) {
	imageBytes := h.externalThumbnail()
	contentType := contentTypeJPEG
	if len(imageBytes) == 0 {
		imageBytes, contentType = h.logoImage()
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	writeBytesAsImage(imageBytes, contentType, w, utils.GetCacheDurationSecondsForPath(thumbnailFilename))
}

// logoImage mirrors GetLogo without writing, so the fallback can use the preview cache lifetime.
func (h *Handlers) logoImage() ([]byte, string) {
	imageFilename := h.configRepository.GetLogoPath()
	if imageFilename == "" {
		return static.GetLogo(), contentTypePNG
	}
	imageBytes, err := getImage(filepath.Join(config.DataDirectory, imageFilename))
	if err != nil {
		return static.GetLogo(), contentTypePNG
	}
	switch filepath.Ext(imageFilename) {
	case ".svg":
		return imageBytes, "image/svg+xml"
	case ".gif":
		return imageBytes, contentTypeGIF
	case ".png":
		return imageBytes, contentTypePNG
	default:
		return imageBytes, contentTypeJPEG
	}
}

func (h *Handlers) externalThumbnail() []byte {
	h.previewThumbMu.Lock()
	defer h.previewThumbMu.Unlock()
	if source := h.stream.ThumbnailURL(); source == "" || source != h.lastThumbnailSource {
		return nil
	}
	return h.lastThumbnailBytes
}

func (h *Handlers) RunThumbnailRefresh(ctx context.Context) {
	if h.stream == nil || !h.stream.HasExternalPlayback() {
		return
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		h.refreshExternalThumbnail(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (h *Handlers) refreshExternalThumbnail(ctx context.Context) {
	h.thumbnailRefreshMu.Lock()
	defer h.thumbnailRefreshMu.Unlock()
	if ctx.Err() != nil {
		return
	}
	h.previewThumbMu.Lock()
	source := h.stream.ThumbnailURL()
	if source != h.lastThumbnailSource {
		h.lastThumbnailSource = source
		h.lastThumbnailBytes = nil
		h.previewThumbCache.DeleteAll()
	}
	h.previewThumbMu.Unlock()
	if source == "" {
		return
	}
	if cached := h.previewThumbCache.Get(source); cached != nil {
		return
	}
	imageBytes, err := h.fetchThumbnail(ctx, source)
	h.previewThumbMu.Lock()
	defer h.previewThumbMu.Unlock()
	if ctx.Err() != nil {
		return
	}
	if source != h.stream.ThumbnailURL() {
		h.lastThumbnailSource = ""
		h.lastThumbnailBytes = nil
		return
	}
	if err != nil {
		imageBytes = h.lastThumbnailBytes
		if len(imageBytes) > 0 {
			log.WithError(err).Warn("Cloudflare Stream thumbnail refresh failed; using last successful thumbnail")
		} else {
			log.WithError(err).Warn("Cloudflare Stream thumbnail refresh failed; using logo")
		}
	} else {
		h.lastThumbnailBytes = imageBytes
	}
	h.previewThumbCache.Set(source, imageBytes, previewCacheTTL)
}

func (h *Handlers) fetchThumbnail(ctx context.Context, source string) ([]byte, error) {
	if h.thumbnailClient == nil {
		return nil, errors.New("thumbnail HTTP client is not configured")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return nil, err
	}
	response, err := h.thumbnailClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("thumbnail returned HTTP %d", response.StatusCode)
	}
	imageBytes, err := io.ReadAll(io.LimitReader(response.Body, maxThumbnailBytes+1))
	if err != nil {
		return nil, err
	}
	if len(imageBytes) > maxThumbnailBytes {
		return nil, errors.New("thumbnail exceeds size limit")
	}
	imageConfig, err := jpeg.DecodeConfig(bytes.NewReader(imageBytes))
	if err != nil || imageConfig.Width > 4096 || imageConfig.Height > 4096 {
		return nil, errors.New("thumbnail is not a supported JPEG")
	}
	if _, err := jpeg.Decode(bytes.NewReader(imageBytes)); err != nil {
		return nil, err
	}
	return imageBytes, nil
}
