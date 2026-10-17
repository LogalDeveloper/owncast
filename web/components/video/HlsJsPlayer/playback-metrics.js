import Hls from 'hls.js';

const URL_CMCD_COLLECTOR = `/api/metrics/cmcd`;
const EVENT_REPORT_INTERVAL = 10000;
const MAX_VALID_LATENCY_SECONDS = 100; // Anything > this gets thrown out.
const CMCD_VERSION = 2;

function generateSessionID() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // randomUUID is only exposed in secure contexts; build a v4 UUID from
  // getRandomValues, which is available everywhere.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // eslint-disable-next-line no-bitwise
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  // eslint-disable-next-line no-bitwise
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

class PlaybackMetrics {
  constructor(player, hls) {
    this.player = player;
    this.hls = hls;
    this.clockSkewMs = 0;
    this.sessionID = generateSessionID();
    this.sequenceNumber = 0;

    this.hasStartedPlaying = false;
    this.isStalled = false;
    this.playRequestedAt = null;
    this.mediaStartDelayMs = null;
    this.mediaStartDelaySent = false;
    this.segmentDownloadTimesMs = [];

    this.handlePlay = this.handlePlay.bind(this);
    this.handlePlaying = this.handlePlaying.bind(this);
    this.handlePause = this.handlePause.bind(this);
    this.handleEnded = this.handleEnded.bind(this);
    this.handleError = this.handleError.bind(this);
    this.handleBuffering = this.handleBuffering.bind(this);
    this.handleNoLongerBuffering = this.handleNoLongerBuffering.bind(this);

    this.listeners = {
      play: this.handlePlay,
      playing: this.handlePlaying,
      pause: this.handlePause,
      ended: this.handleEnded,
      error: this.handleError,
      stalled: this.handleBuffering,
      waiting: this.handleBuffering,
      canplaythrough: this.handleNoLongerBuffering,
    };
    Object.entries(this.listeners).forEach(([event, listener]) => {
      this.player.addEventListener(event, listener);
    });
    this.handleFragmentLoaded = (_event, { frag, part }) => {
      const stats = part ? part.stats : frag.stats;
      if (frag.type === 'main' && stats.loading.end > stats.loading.start) {
        this.segmentDownloadTimesMs.push(stats.loading.end - stats.loading.start);
      }
    };
    this.handleHlsError = (_event, data) => {
      if (data.fatal) this.sendEventReport('e', { ec: data.details });
    };
    this.hls?.on(Hls.Events.FRAG_LOADED, this.handleFragmentLoaded);
    this.hls?.on(Hls.Events.ERROR, this.handleHlsError);

    this.eventReportTimer = setInterval(() => {
      if (!this.player || !this.hasStartedPlaying) {
        return;
      }
      if (this.player.paused) {
        // Viewer pings keep a paused tab active. Refresh its CMCD state too,
        // or the server prunes its health before the viewer.
        this.sendEventReport('t', { sta: 'a' });
        return;
      }
      this.sendEventReport('t');
    }, EVENT_REPORT_INTERVAL);
  }

  stop() {
    clearInterval(this.eventReportTimer);
    if (this.hasStartedPlaying && !this.player.ended) {
      this.sendEventReport('ps', { sta: 'e' });
    }
    Object.entries(this.listeners).forEach(([event, listener]) => {
      this.player.removeEventListener(event, listener);
    });
    this.hls?.off(Hls.Events.FRAG_LOADED, this.handleFragmentLoaded);
    this.hls?.off(Hls.Events.ERROR, this.handleHlsError);
  }

  // Keep our client clock in sync with the server clock to determine
  // accurate latency calculations.
  setClockSkew(skewMs) {
    this.clockSkewMs = skewMs;
  }

  handlePlay() {
    if (this.playRequestedAt === null) {
      this.playRequestedAt = Date.now();
    }
  }

  handlePlaying() {
    if (this.mediaStartDelayMs === null && this.playRequestedAt !== null) {
      this.mediaStartDelayMs = Date.now() - this.playRequestedAt;
    }
    const firstPlay = !this.hasStartedPlaying;
    this.hasStartedPlaying = true;
    this.isStalled = false;
    if (firstPlay) {
      this.sendEventReport('ps', { sta: 'p' });
    }
  }

  handlePause() {
    if (!this.player.ended) {
      this.sendEventReport('ps', { sta: 'a' });
    }
  }

  handleEnded() {
    this.sendEventReport('ps', { sta: 'e' });
  }

  handleError() {
    const error = this.player.error;
    this.sendEventReport('e', { ec: error ? String(error.code) : undefined });
  }

  handleBuffering() {
    if (!this.hasStartedPlaying || this.player.seeking || this.isStalled) {
      return;
    }
    this.isStalled = true;
    this.sendEventReport('ps', { sta: 'w', bs: true });
  }

  handleNoLongerBuffering() {
    this.isStalled = false;
  }

  // CMCD keys shared by request-mode decoration and event reports.
  commonCmcdKeys() {
    const keys = {
      v: CMCD_VERSION,
      sid: this.sessionID,
    };

    const throughput = this.measuredThroughputKbps();
    if (throughput) {
      keys.mtp = throughput;
    }

    const bitrate = this.currentBitrateKbps();
    if (bitrate) {
      keys.br = bitrate;
    }

    const buffer = this.bufferLengthMs();
    if (buffer !== null) {
      keys.bl = buffer;
    }

    const latency = this.liveLatencyMs();
    if (latency !== null) {
      keys.ltc = latency;
    }

    const playbackRate = this.player.playbackRate;
    if (playbackRate !== 1) {
      keys.pr = playbackRate;
    }

    return keys;
  }

  async sendEventReport(event, extraKeys = {}) {
    this.sequenceNumber += 1;

    const report = {
      ...this.commonCmcdKeys(),
      ...extraKeys,
      e: event,
      ts: Date.now(),
      sn: this.sequenceNumber,
    };

    if (report.sta === undefined) {
      report.sta = this.playerStateToken();
    }

    if (!this.mediaStartDelaySent && this.mediaStartDelayMs !== null) {
      this.mediaStartDelaySent = true;
      report.msd = this.mediaStartDelayMs;
    }

    const droppedFrames = this.droppedFrameCount();
    if (droppedFrames) {
      report.df = droppedFrames;
    }

    // Average client-measured segment download time since the last report,
    // reported as ttlb in milliseconds.
    if (this.segmentDownloadTimesMs.length > 0) {
      const sum = this.segmentDownloadTimesMs.reduce((p, c) => p + c, 0);
      report.ttlb = Math.round(sum / this.segmentDownloadTimesMs.length);
      this.segmentDownloadTimesMs = [];
    }

    Object.keys(report).forEach(key => {
      if (report[key] === undefined || report[key] === null) {
        delete report[key];
      }
    });

    try {
      await fetch(URL_CMCD_COLLECTOR, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(report),
      });
    } catch (e) {
      console.error(e);
    }
  }

  playerStateToken() {
    if (this.player.seeking) {
      return 'k';
    }
    if (this.player.ended) {
      return 'e';
    }
    if (this.player.paused) {
      return 'a';
    }
    if (this.isStalled) {
      return 'w';
    }
    return 'p';
  }

  measuredThroughputKbps() {
    const bandwidth = this.hls?.bandwidthEstimate;
    if (!Number.isFinite(bandwidth) || bandwidth <= 0) {
      return null;
    }
    // The spec asks for throughput rounded to the nearest 100kbps.
    return Math.round(bandwidth / 1000 / 100) * 100;
  }

  currentBitrateKbps() {
    const bandwidth = this.hls?.levels[this.hls.currentLevel]?.bitrate;
    if (!bandwidth) {
      return null;
    }
    return Math.round(bandwidth / 1000);
  }

  bufferLengthMs() {
    try {
      const buffered = this.player.buffered;
      if (!buffered || buffered.length === 0) {
        return null;
      }
      const bufferMs = (buffered.end(buffered.length - 1) - this.player.currentTime) * 1000;
      if (bufferMs < 0) {
        return null;
      }
      // The spec asks for buffer length rounded to the nearest 100ms.
      return Math.round(bufferMs / 100) * 100;
    } catch {
      return null;
    }
  }

  liveLatencyMs() {
    try {
      const playingDate = this.hls?.playingDate;
      if (!playingDate) return null;
      const latency = Date.now() + this.clockSkewMs - playingDate.getTime();
      if (!Number.isFinite(latency) || latency < 0 || latency / 1000 >= MAX_VALID_LATENCY_SECONDS) {
        return null;
      }

      return Math.round(latency);
    } catch {
      return null;
    }
  }

  droppedFrameCount() {
    if (!this.player.getVideoPlaybackQuality) {
      return null;
    }
    return this.player.getVideoPlaybackQuality().droppedVideoFrames || null;
  }
}

export default PlaybackMetrics;
