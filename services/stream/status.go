package stream

import (
	"github.com/owncast/owncast/config"
	"github.com/owncast/owncast/models"
)

// GetStatus returns a snapshot of the current stream state suitable for
// the public/admin status APIs.
func (s *Service) GetStatus() models.Status {
	s.statsMu.RLock()
	defer s.statsMu.RUnlock()
	if s.stats == nil {
		return models.Status{}
	}

	viewerCount := 0
	online := s.isStreamConnectedLocked()
	if online {
		viewerCount = len(s.stats.Viewers)
		if engine, ok := s.engine.(ExternalPlayback); ok {
			viewerCount = engine.ViewerCount()
		}
	}

	return models.Status{
		Online:                online,
		ViewerCount:           viewerCount,
		OverallMaxViewerCount: s.stats.OverallMaxViewerCount,
		SessionMaxViewerCount: s.stats.SessionMaxViewerCount,
		LastDisconnectTime:    s.stats.LastDisconnectTime,
		LastConnectTime:       s.stats.LastConnectTime,
		VersionNumber:         config.VersionNumber,
		StreamTitle:           s.configRepository.GetStreamTitle(),
	}
}

// GetCurrentBroadcast returns the in-flight broadcast settings, or nil
// if no stream is currently live.
func (s *Service) GetCurrentBroadcast() *models.CurrentBroadcast {
	s.statsMu.RLock()
	defer s.statsMu.RUnlock()
	return s.currentBroadcast
}

// BroadcasterSet records the metadata of the inbound source. Implements
// StreamEvents; the local engine calls it from the RTMP metadata callback, a
// remote engine from its signaling channel.
func (s *Service) BroadcasterSet(broadcaster models.Broadcaster) {
	s.statsMu.Lock()
	defer s.statsMu.Unlock()
	s.broadcaster = &broadcaster
}

// GetBroadcaster returns the active inbound broadcaster, or nil between
// streams.
func (s *Service) GetBroadcaster() *models.Broadcaster {
	s.statsMu.RLock()
	defer s.statsMu.RUnlock()
	return s.broadcaster
}
