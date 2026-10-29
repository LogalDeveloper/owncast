package stream

import (
	"math"
	"time"

	log "github.com/sirupsen/logrus"

	"github.com/owncast/owncast/models"
)

// ViewerCountUpdated records a provider viewer-count sample into the session
// and overall peaks. Implements StreamEvents; ignored for the local engine,
// whose peaks come from SetViewerActive.
func (s *Service) ViewerCountUpdated(count int) {
	s.statsMu.Lock()
	defer s.statsMu.Unlock()
	if !s.HasExternalPlayback() || s.stats == nil || !s.stats.StreamConnected || count < 0 {
		return
	}
	s.stats.SessionMaxViewerCount = max(count, s.stats.SessionMaxViewerCount)
	s.stats.OverallMaxViewerCount = max(count, s.stats.OverallMaxViewerCount)
}

// setupStats restores stats from the previous session and starts the
// periodic save + viewer-prune goroutines.
func (s *Service) setupStats() error {
	saved := s.getSavedStats()
	s.stats = &saved

	statsSaveTicker := time.NewTicker(1 * time.Minute)
	go func() {
		for range statsSaveTicker.C {
			s.saveStats()
		}
	}()

	viewerCountPruneTicker := time.NewTicker(5 * time.Second)
	go func() {
		for range viewerCountPruneTicker.C {
			s.pruneViewerCount()
		}
	}()

	return nil
}

// IsStreamConnected reports whether the stream is actively delivering
// live HLS content. Returns false during the brief warm-up after an
// RTMP connection where HLS segments aren't ready yet.
func (s *Service) IsStreamConnected() bool {
	s.statsMu.RLock()
	defer s.statsMu.RUnlock()
	return s.isStreamConnectedLocked()
}

func (s *Service) isStreamConnectedLocked() bool {
	if s.stats == nil || !s.stats.StreamConnected {
		return false
	}
	if s.HasExternalPlayback() {
		return true
	}
	if s.stats.LastConnectTime == nil {
		return false
	}

	// Kind of a hack. It takes a handful of seconds between an RTMP
	// connection and when HLS data is available. Account for that with
	// an artificial buffer of a few segments.
	timeSinceLastConnected := time.Since(s.stats.LastConnectTime.Time).Seconds()
	waitTime := math.Max(float64(s.configRepository.GetStreamLatencyLevel().SecondsPerSegment)*3.0, 7)
	if timeSinceLastConnected < waitTime {
		return false
	}

	return s.stats.StreamConnected
}

// RemoveChatClient removes a chat client from the active-clients record.
// Currently unused — kept for now during the migration; remove once
// confirmed dead.
func (s *Service) RemoveChatClient(clientID string) {
	log.Trace("Removing the client:", clientID)

	s.statsMu.Lock()
	delete(s.stats.ChatClients, clientID)
	s.statsMu.Unlock()
}

// SetViewerActive marks a viewer as currently watching and updates the
// session/overall peak counters. Silent no-op while no stream is live.
func (s *Service) SetViewerActive(viewer *models.Viewer) {
	s.statsMu.Lock()
	defer s.statsMu.Unlock()
	if s.HasExternalPlayback() || s.stats == nil || !s.stats.StreamConnected {
		return
	}

	// Asynchronously, optionally, fetch GeoIP info. The lookup can be slow,
	// so it lands on the stored viewer later, under the same lock every
	// other reader takes.
	go func(clientID, ipAddress string) {
		geo := s.geoIPClient.GetGeoFromIP(ipAddress)

		s.statsMu.Lock()
		defer s.statsMu.Unlock()
		if stored, ok := s.stats.Viewers[clientID]; ok {
			stored.Geo = geo
		}
	}(viewer.ClientID, viewer.IPAddress)

	if _, exists := s.stats.Viewers[viewer.ClientID]; exists {
		s.stats.Viewers[viewer.ClientID].LastSeen = time.Now()
	} else {
		copyViewer := *viewer
		s.stats.Viewers[viewer.ClientID] = &copyViewer
	}
	s.stats.SessionMaxViewerCount = max(len(s.stats.Viewers), s.stats.SessionMaxViewerCount)
	s.stats.OverallMaxViewerCount = max(s.stats.SessionMaxViewerCount, s.stats.OverallMaxViewerCount)
}

// GetActiveViewers returns a snapshot of the currently-tracked viewers.
// The viewers are copied because the live map and the viewers in it are
// mutated by request handlers and the prune goroutine while callers read.
func (s *Service) GetActiveViewers() map[string]models.Viewer {
	s.statsMu.RLock()
	defer s.statsMu.RUnlock()
	if s.stats == nil {
		return nil
	}

	viewers := make(map[string]models.Viewer, len(s.stats.Viewers))
	for id, viewer := range s.stats.Viewers {
		viewers[id] = *viewer
	}
	return viewers
}

func (s *Service) pruneViewerCount() {
	viewers := make(map[string]*models.Viewer)

	s.statsMu.Lock()
	defer s.statsMu.Unlock()

	for viewerID, viewer := range s.stats.Viewers {
		if time.Since(s.stats.Viewers[viewerID].LastSeen) < activeViewerPurgeTimeout {
			viewers[viewerID] = viewer
		}
	}

	s.stats.Viewers = viewers
}

func (s *Service) saveStats() {
	s.statsMu.RLock()
	stats := *s.stats
	s.statsMu.RUnlock()
	if err := s.configRepository.SetPeakOverallViewerCount(stats.OverallMaxViewerCount); err != nil {
		log.Errorln("error saving viewer count", err)
	}
	if err := s.configRepository.SetPeakSessionViewerCount(stats.SessionMaxViewerCount); err != nil {
		log.Errorln("error saving viewer count", err)
	}
	// Persist a recent live heartbeat while the stream is online so an unclean
	// shutdown (SIGKILL, node reboot, container eviction) still leaves a useful
	// "last live" timestamp on the next startup. A graceful disconnect below will
	// overwrite this with the real end time.
	if stats.StreamConnected && stats.LastConnectTime != nil && stats.LastConnectTime.Valid {
		if err := s.configRepository.SetLastDisconnectTime(time.Now()); err != nil {
			log.Errorln("error saving live heartbeat time", err)
		}
		return
	}
	if stats.LastDisconnectTime != nil && stats.LastDisconnectTime.Valid {
		if err := s.configRepository.SetLastDisconnectTime(stats.LastDisconnectTime.Time); err != nil {
			log.Errorln("error saving disconnect time", err)
		}
	}
}

func (s *Service) getSavedStats() models.Stats {
	savedLastDisconnectTime, _ := s.configRepository.GetLastDisconnectTime()

	result := models.Stats{
		ChatClients:           make(map[string]models.Client),
		Viewers:               make(map[string]*models.Viewer),
		SessionMaxViewerCount: s.configRepository.GetPeakSessionViewerCount(),
		OverallMaxViewerCount: s.configRepository.GetPeakOverallViewerCount(),
		LastDisconnectTime:    savedLastDisconnectTime,
	}

	// If the stats were saved > 5min ago then ignore the
	// peak session count value, since the session is over.
	if result.LastDisconnectTime == nil || !result.LastDisconnectTime.Valid || time.Since(result.LastDisconnectTime.Time).Minutes() > 5 {
		result.SessionMaxViewerCount = 0
	}

	return result
}
