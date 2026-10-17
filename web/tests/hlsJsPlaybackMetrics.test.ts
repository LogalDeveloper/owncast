import PlaybackMetrics from '../components/video/HlsJsPlayer/playback-metrics';

type Listener = () => void;

const makePlayer = () => {
  const listeners = new Map<string, Listener>();
  let paused = false;
  return {
    buffered: { length: 0 },
    currentTime: 0,
    ended: false,
    error: null,
    removeEventListener: jest.fn((event: string) => listeners.delete(event)),
    addEventListener: jest.fn((event: string, listener: Listener) =>
      listeners.set(event, listener),
    ),
    get paused() {
      return paused;
    },
    playbackRate: 1,
    seeking: false,
    setPaused: (value: boolean) => {
      paused = value;
    },
    trigger: (event: string) => listeners.get(event)?.(),
  };
};

describe('PlaybackMetrics', () => {
  beforeEach(() => {
    global.fetch = jest.fn(() => Promise.resolve({})) as jest.Mock;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('reports ended when a started player is torn down', async () => {
    jest.useFakeTimers();
    const player = makePlayer();
    const metrics = new PlaybackMetrics(player, null);

    player.trigger('playing');
    await Promise.resolve();
    metrics.stop();
    await Promise.resolve();

    const reports = (global.fetch as jest.Mock).mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(reports.map(report => report.sta)).toEqual(['p', 'e']);
  });

  test('reports a pause after playback starts', async () => {
    jest.useFakeTimers();
    const player = makePlayer();
    const metrics = new PlaybackMetrics(player, null);
    expect(metrics).toBeDefined();

    player.trigger('playing');
    player.trigger('pause');
    await Promise.resolve();

    const reports = (global.fetch as jest.Mock).mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(reports.map(report => report.sta)).toEqual(['p', 'a']);
  });

  test('keeps a paused session fresh beyond the server stale timeout', async () => {
    jest.useFakeTimers();
    const player = makePlayer();
    const metrics = new PlaybackMetrics(player, null);
    expect(metrics).toBeDefined();

    player.trigger('playing');
    player.setPaused(true);
    player.trigger('pause');
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();

    const reports = (global.fetch as jest.Mock).mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(reports.map(report => report.sta)).toEqual(['p', 'a', 'a', 'a', 'a', 'a', 'a', 'a']);
  });

  test('reports hls.js bitrate, throughput, clock-adjusted latency and fragment timing', async () => {
    jest.useFakeTimers();
    const player = makePlayer();
    const hls = {
      on: jest.fn(),
      off: jest.fn(),
      currentLevel: 0,
      levels: [{ bitrate: 2_000_000 }],
      bandwidthEstimate: 3_050_000,
      playingDate: new Date(Date.now() - 5000),
    };
    const metrics = new PlaybackMetrics(player, hls);
    metrics.setClockSkew(1000);
    const fragmentListener = hls.on.mock.calls.find(([event]) => event === 'hlsFragLoaded')[1];
    fragmentListener(null, {
      frag: { type: 'main', stats: { loading: { start: 100, end: 250 } } },
      part: null,
    });
    fragmentListener(null, {
      frag: { type: 'main', stats: { loading: { start: 100, end: 900 } } },
      part: { stats: { loading: { start: 300, end: 350 } } },
    });
    fragmentListener(null, {
      frag: { type: 'audio', stats: { loading: { start: 100, end: 500 } } },
      part: null,
    });
    player.trigger('playing');
    await Promise.resolve();

    const report = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(report).toMatchObject({ v: 2, br: 2000, mtp: 3100, ltc: 6000, ttlb: 100 });
    metrics.stop();
    expect(player.removeEventListener).toHaveBeenCalledTimes(8);
    expect(hls.off).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });
});
