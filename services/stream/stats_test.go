package stream

import (
	"os"
	"testing"
	"time"

	"github.com/owncast/owncast/config"
	"github.com/owncast/owncast/models"
	"github.com/owncast/owncast/persistence/configrepository"
	"github.com/owncast/owncast/services/datastore"
	"github.com/owncast/owncast/utils"
)

func TestExternalStatusAndProviderPeaks(t *testing.T) {
	repo := newStreamStatsTestRepo(t)
	s := New(Deps{ConfigRepository: repo, Config: config.NewDefault(), EngineFactory: func(StreamEvents) StreamEngine {
		return &fakeExternalEngine{}
	}})
	stats := s.getSavedStats()
	stats.StreamConnected = true
	stats.LastConnectTime = &utils.NullTime{Time: time.Now(), Valid: true}
	s.stats = &stats
	if !s.IsStreamConnected() || s.GetCurrentBroadcast() != nil || s.GetBroadcaster() != nil {
		t.Fatal("external stream imposed local warm-up or invented encoder metadata")
	}
	for index := range 10 {
		s.SetViewerActive(&models.Viewer{ClientID: string(rune('a' + index)), LastSeen: time.Now()})
	}
	if len(s.GetActiveViewers()) != 0 {
		t.Fatal("external playback must not collect local viewer records")
	}
	if s.GetStatus().ViewerCount != 42 || s.GetStatus().SessionMaxViewerCount != 0 {
		t.Fatal("local viewer activity changed provider count or peaks")
	}
	s.ViewerCountUpdated(7)
	s.ViewerCountUpdated(3)
	s.ViewerCountUpdated(-1)
	if s.GetStatus().SessionMaxViewerCount != 7 {
		t.Fatal("provider samples did not control session peak")
	}
	s.saveStats()
	if repo.GetPeakSessionViewerCount() != 7 || repo.GetPeakOverallViewerCount() != 7 {
		t.Fatal("provider peaks were not persisted")
	}
	s.statsMu.Lock()
	s.stats.StreamConnected = false
	s.statsMu.Unlock()
	s.ViewerCountUpdated(100)
	status := s.GetStatus()
	if status.Online || status.ViewerCount != 0 || status.SessionMaxViewerCount != 7 {
		t.Fatal("offline stream reported viewers or changed provider peaks")
	}
	if s.storage != nil || s.fileWriter != nil || s.transcoder != nil || s.thumbnailGen != nil || s.onlineCleanupTicker != nil || s.offlineCleanupTimer != nil {
		t.Fatal("external lifecycle activated local media processing")
	}
}

func newStreamStatsTestRepo(t *testing.T) configrepository.ConfigRepository {
	t.Helper()
	ds, err := datastore.SetupPersistence(":memory:", os.TempDir())
	if err != nil {
		t.Fatalf("failed to set up datastore: %v", err)
	}
	return configrepository.New(ds)
}

func TestSaveStatsPersistsRecentLastLiveHeartbeatWhileOnline(t *testing.T) {
	repo := newStreamStatsTestRepo(t)
	connectedAt := time.Now().Add(-3 * time.Hour)
	s := &Service{
		configRepository: repo,
		stats: &models.Stats{
			StreamConnected: true,
			LastConnectTime: &utils.NullTime{Time: connectedAt, Valid: true},
		},
	}

	beforeSave := time.Now().Add(-2 * time.Second)
	s.saveStats()

	got, err := repo.GetLastDisconnectTime()
	if err != nil {
		t.Fatalf("GetLastDisconnectTime: %v", err)
	}
	if got == nil || !got.Valid {
		t.Fatal("expected an online heartbeat timestamp to be persisted")
	}
	if got.Time.Before(beforeSave) {
		t.Fatalf("persisted timestamp %v is older than save window start %v", got.Time, beforeSave)
	}
	if got.Time.Before(connectedAt) {
		t.Fatalf("persisted timestamp %v should not predate the live session start %v", got.Time, connectedAt)
	}

	restored := (&Service{configRepository: repo}).getSavedStats()
	if restored.LastDisconnectTime == nil || !restored.LastDisconnectTime.Valid {
		t.Fatal("expected restored stats to include the persisted last-live timestamp")
	}
	if restored.LastDisconnectTime.Time.Before(beforeSave) {
		t.Fatalf("restored timestamp %v is older than save window start %v", restored.LastDisconnectTime.Time, beforeSave)
	}
}

func TestSaveStatsPersistsExplicitDisconnectTimeWhenOffline(t *testing.T) {
	repo := newStreamStatsTestRepo(t)
	disconnectedAt := time.Now().Add(-45 * time.Minute).Round(time.Second)
	s := &Service{
		configRepository: repo,
		stats: &models.Stats{
			StreamConnected:    false,
			LastDisconnectTime: &utils.NullTime{Time: disconnectedAt, Valid: true},
		},
	}

	s.saveStats()

	got, err := repo.GetLastDisconnectTime()
	if err != nil {
		t.Fatalf("GetLastDisconnectTime: %v", err)
	}
	if got == nil || !got.Valid {
		t.Fatal("expected a disconnect timestamp to be persisted")
	}
	if !got.Time.Equal(disconnectedAt) {
		t.Fatalf("persisted disconnect time = %v, want %v", got.Time, disconnectedAt)
	}
}
