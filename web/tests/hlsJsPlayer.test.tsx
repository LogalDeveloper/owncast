import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import Hls from 'hls.js';
import { HlsPlayer } from '../components/video/HlsJsPlayer/HlsPlayer';
import { PlayerControls } from '../components/video/HlsJsPlayer/PlayerControls';
import { HlsJsPlayer } from '../components/video/HlsJsPlayer/HlsJsPlayer';
import { AutoplaySetting } from '../utils/autoplay';

jest.mock('next-export-i18n', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('../components/video/airplay.svg', () => () => <span />);
jest.mock('../components/video/VideoPoster/VideoPoster', () => ({
  VideoPoster: () => <div data-testid="poster" />,
}));
jest.mock('react-error-boundary', () => ({
  ErrorBoundary: ({ children }) => children,
  getErrorMessage: (error: Error) => error.message,
}));
jest.mock('hls.js', () => {
  const constructor = jest.fn().mockImplementation(config => {
    const listeners = new Map<string, Set<(...args: any[]) => void>>();
    return {
      config: { lowLatencyMode: true, ...config },
      on: jest.fn((event, listener) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(listener);
      }),
      off: jest.fn((event, listener) => listeners.get(event)?.delete(listener)),
      trigger: (event, data) => listeners.get(event)?.forEach(listener => listener(event, data)),
      loadSource: jest.fn(),
      startLoad: jest.fn(),
      stopLoad: jest.fn(),
      attachMedia: jest.fn(),
      destroy: jest.fn(),
      recoverMediaError: jest.fn(),
      latency: 3,
      targetLatency: 3,
      liveSyncPosition: 137,
      autoLevelEnabled: true,
      manualLevel: -1,
      currentLevel: -1,
      levels: [
        { height: 720, bitrate: 2_000_000 },
        { height: 1080, bitrate: 4_000_000 },
      ],
    };
  });
  return {
    __esModule: true,
    default: Object.assign(constructor, {
      isSupported: jest.fn(() => true),
      Events: {
        ERROR: 'hlsError',
        FRAG_LOADED: 'hlsFragLoaded',
        MANIFEST_PARSED: 'hlsManifestParsed',
        LEVELS_UPDATED: 'hlsLevelsUpdated',
      },
      ErrorTypes: { MEDIA_ERROR: 'mediaError', NETWORK_ERROR: 'networkError' },
      ErrorDetails: { BUFFER_STALLED_ERROR: 'bufferStalledError' },
    }),
  };
});

const source = '/hls/stream.m3u8';
const latestEngine = () => (Hls as unknown as jest.Mock).mock.results.at(-1).value;
const makeVideo = () => {
  const video = document.createElement('video');
  document.body.appendChild(video);
  video.currentTime = 120;
  Object.defineProperty(video, 'seekable', {
    value: { length: 1, start: () => 100, end: () => 140 },
  });
  return video;
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  (Hls.isSupported as jest.Mock).mockReturnValue(true);
  jest.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  jest.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  jest.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  global.fetch = jest.fn().mockResolvedValue({});
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  document.querySelectorAll('body > video').forEach(video => video.remove());
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('creates one HLS instance with low-latency playback and cleans up on source changes', () => {
  const cleanupMedia = jest.fn();
  const onReady = jest.fn(() => cleanupMedia);
  const onError = jest.fn();
  const view = render(
    <HlsPlayer source={source} title="Stream" onReady={onReady} onError={onError} />,
  );
  const first = latestEngine();
  expect(Hls).toHaveBeenCalledWith(
    expect.objectContaining({
      autoStartLoad: false,
      lowLatencyMode: true,
      maxLiveSyncPlaybackRate: 1,
      startLevel: -1,
    }),
  );
  expect(first.loadSource).not.toHaveBeenCalled();
  expect(first.startLoad).not.toHaveBeenCalled();
  view.rerender(
    <HlsPlayer source={source} title="New title" onReady={onReady} onError={onError} />,
  );
  expect(Hls).toHaveBeenCalledTimes(1);
  view.rerender(
    <HlsPlayer source="/another.m3u8" title="Stream" onReady={onReady} onError={onError} />,
  );
  expect(first.destroy).toHaveBeenCalledTimes(1);
  expect(cleanupMedia).toHaveBeenCalledTimes(1);
  const second = latestEngine();
  view.unmount();
  expect(second.destroy).toHaveBeenCalledTimes(1);
  expect(cleanupMedia).toHaveBeenCalledTimes(2);
});

test('loads only on play, stops on pause or end, and resumes without reloading the source', () => {
  const view = render(
    <HlsPlayer source={source} title="Stream" onReady={jest.fn()} onError={jest.fn()} />,
  );
  const video = screen.getByLabelText('Stream');
  const hls = latestEngine();
  expect(video).toHaveAttribute('preload', 'none');
  expect(hls.loadSource).not.toHaveBeenCalled();
  expect(hls.startLoad).not.toHaveBeenCalled();
  fireEvent.play(video);
  expect(hls.loadSource).toHaveBeenCalledWith(source);
  expect(hls.startLoad).toHaveBeenCalledTimes(1);
  fireEvent.pause(video);
  expect(hls.stopLoad).toHaveBeenCalledTimes(1);
  act(() => jest.advanceTimersByTime(60_000));
  expect(hls.startLoad).toHaveBeenCalledTimes(1);
  fireEvent.play(video);
  expect(hls.startLoad).toHaveBeenCalledTimes(2);
  expect(hls.loadSource).toHaveBeenCalledTimes(1);
  fireEvent.ended(video);
  expect(hls.stopLoad).toHaveBeenCalledTimes(2);
  view.unmount();
  fireEvent.play(video);
  expect(hls.startLoad).toHaveBeenCalledTimes(2);
});

test('keeps the viewer idle until play and stops loading when the viewer pauses', async () => {
  (HTMLMediaElement.prototype.play as jest.Mock).mockImplementation(function playVideo() {
    fireEvent.play(this);
    return Promise.resolve();
  });
  render(<HlsJsPlayer source={source} title="Stream" online />);
  const video = screen.getByLabelText('Stream') as HTMLVideoElement;
  const hls = latestEngine();
  expect(video.play).not.toHaveBeenCalled();
  expect(hls.loadSource).not.toHaveBeenCalled();
  expect(hls.startLoad).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getAllByRole('button', { name: 'Play' })[0]));
  expect(hls.loadSource).toHaveBeenCalledWith(source);
  expect(hls.startLoad).toHaveBeenCalledTimes(1);
  fireEvent.playing(video);
  fireEvent.pause(video);
  expect(hls.stopLoad).toHaveBeenCalledTimes(1);
  act(() => jest.advanceTimersByTime(60_000));
  expect(hls.startLoad).toHaveBeenCalledTimes(1);
  expect(hls.loadSource).toHaveBeenCalledTimes(1);
});

test('uses a valid real hls.js configuration with adaptive latency and automatic quality', () => {
  render(<HlsPlayer source={source} title="Stream" onReady={jest.fn()} onError={jest.fn()} />);
  const ActualHls = jest.requireActual('hls.js');
  const config = (Hls as unknown as jest.Mock).mock.calls.at(-1)[0];
  const engine = new ActualHls(config);
  expect(engine.config.autoStartLoad).toBe(false);
  expect(engine.config.lowLatencyMode).toBe(true);
  expect(engine.config.liveSyncDurationCount).toBe(3);
  expect(engine.config.liveMaxLatencyDurationCount).toBe(Infinity);
  expect(engine.config.maxLiveSyncPlaybackRate).toBe(1);
  expect(engine.config.liveSyncOnStallIncrease).toBeGreaterThan(0);
  expect(engine.config.startLevel).toBe(-1);
  Object.defineProperty(engine, 'latestLevelDetails', {
    value: { targetduration: 3, holdBack: 0, partHoldBack: 1.5 },
  });
  expect(engine.targetLatency).toBe(1.5);
  engine.config.lowLatencyMode = false;
  expect(engine.targetLatency).toBe(9);
  engine.destroy();
});

test('keeps low latency enabled after repeated playback stalls and source changes', () => {
  const onReady = jest.fn();
  const onError = jest.fn();
  const view = render(
    <HlsPlayer source={source} title="Stream" onReady={onReady} onError={onError} />,
  );
  const video = screen.getByLabelText('Stream') as HTMLVideoElement;
  Object.defineProperty(video, 'paused', { value: false });
  fireEvent.play(video);
  video.currentTime = 120;
  const hls = latestEngine();
  const stall = { fatal: false, details: Hls.ErrorDetails.BUFFER_STALLED_ERROR };
  hls.trigger(Hls.Events.ERROR, stall);
  expect(hls.config.lowLatencyMode).toBe(true);
  act(() => jest.advanceTimersByTime(10_000));
  hls.trigger(Hls.Events.ERROR, stall);
  expect(hls.config.lowLatencyMode).toBe(true);
  expect(hls.config.maxLiveSyncPlaybackRate).toBe(1);
  expect(hls.autoLevelEnabled).toBe(true);
  expect(video.currentTime).toBe(120);
  expect(video.pause).not.toHaveBeenCalled();
  expect(hls.loadSource).toHaveBeenCalledTimes(1);
  expect(hls.recoverMediaError).not.toHaveBeenCalled();
  expect(onReady).toHaveBeenCalledTimes(1);
  expect(onError).not.toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(120_000));
  expect(hls.config.lowLatencyMode).toBe(true);
  view.rerender(
    <HlsPlayer source="/another.m3u8" title="Stream" onReady={onReady} onError={onError} />,
  );
  const next = latestEngine();
  next.trigger(Hls.Events.ERROR, stall);
  expect(next.config.lowLatencyMode).toBe(true);
});

test('prefers hls.js when both native playback and MSE are available', () => {
  (Hls.isSupported as jest.Mock).mockReturnValue(true);
  jest.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('maybe');
  const onReady = jest.fn();
  render(<HlsPlayer source={source} title="Stream" onReady={onReady} onError={jest.fn()} />);
  expect(Hls).toHaveBeenCalledTimes(1);
  expect(latestEngine().attachMedia).toHaveBeenCalled();
  const video = screen.getByLabelText('Stream');
  expect(video).toHaveAttribute('playsinline');
  expect(video).toHaveAttribute('preload', 'none');
  expect(onReady).toHaveBeenCalledWith(video, latestEngine());
});

test('falls back to native HLS when MSE is unavailable', () => {
  (Hls.isSupported as jest.Mock).mockReturnValue(false);
  jest.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('maybe');
  const onReady = jest.fn();
  render(<HlsPlayer source={source} title="Stream" onReady={onReady} onError={jest.fn()} />);
  expect(Hls).not.toHaveBeenCalled();
  const video = screen.getByLabelText('Stream');
  expect(video).toHaveAttribute('src', source);
  expect(video).toHaveAttribute('playsinline');
  expect(video).toHaveAttribute('preload', 'none');
  expect(onReady).toHaveBeenCalledWith(video, null);
});

test('reports unsupported browsers and bounds fatal media-error recovery', () => {
  const onError = jest.fn();
  const view = render(
    <HlsPlayer source={source} title="Stream" onReady={jest.fn()} onError={onError} />,
  );
  const hls = latestEngine();
  fireEvent.error(screen.getByLabelText('Stream'));
  hls.trigger(Hls.Events.ERROR, { fatal: false });
  expect(onError).not.toHaveBeenCalled();
  hls.trigger(Hls.Events.ERROR, { fatal: true, type: Hls.ErrorTypes.MEDIA_ERROR });
  expect(hls.recoverMediaError).toHaveBeenCalledTimes(1);
  hls.trigger(Hls.Events.ERROR, { fatal: true, type: Hls.ErrorTypes.MEDIA_ERROR });
  expect(onError).toHaveBeenCalledTimes(1);
  view.unmount();
  (Hls.isSupported as jest.Mock).mockReturnValue(false);
  jest.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('');
  render(<HlsPlayer source={source} title="Stream" onReady={jest.fn()} onError={onError} />);
  expect(onError).toHaveBeenCalledTimes(2);
});

test('only jumps to the HLS live position after a viewer clicks the behind indicator', () => {
  const video = makeVideo();
  const hls = new Hls();
  const onPlay = jest.fn();
  const view = render(
    <PlayerControls
      video={video}
      hls={hls}
      playing
      onPlay={onPlay}
      onAudioInteraction={jest.fn()}
    />,
  );
  expect(screen.getByText('Live (Low Latency)')).toBeInTheDocument();
  view.rerender(
    <PlayerControls
      video={video}
      hls={hls}
      playing={false}
      onPlay={onPlay}
      onAudioInteraction={jest.fn()}
    />,
  );
  expect(screen.queryByText('Live (Low Latency)')).not.toBeInTheDocument();
  view.rerender(
    <PlayerControls
      video={video}
      hls={hls}
      playing
      onPlay={onPlay}
      onAudioInteraction={jest.fn()}
    />,
  );
  expect(screen.queryByRole('button', { name: 'Picture in picture' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'AirPlay' })).not.toBeInTheDocument();
  Object.assign(hls, { latency: 10 });
  act(() => jest.advanceTimersByTime(1000));
  expect(video.currentTime).toBe(120);
  fireEvent.click(screen.getByRole('button', { name: '~10s behind' }));
  expect(video.currentTime).toBe(137);
  expect(onPlay).toHaveBeenCalledTimes(1);
  expect(video.playbackRate).toBe(1);
});

test('shows the plain live label when low-latency mode is disabled', () => {
  const video = makeVideo();
  const hls = new Hls();
  hls.config.lowLatencyMode = false;
  render(
    <PlayerControls
      video={video}
      hls={hls}
      playing
      onPlay={jest.fn()}
      onAudioInteraction={jest.fn()}
    />,
  );
  expect(screen.getByText('Live')).toBeInTheDocument();
  expect(screen.queryByText('Live (Low Latency)')).not.toBeInTheDocument();
});

test('estimates native latency and hides quality selection without hls.js', () => {
  const video = makeVideo();
  render(
    <PlayerControls
      video={video}
      hls={null}
      playing
      onPlay={jest.fn()}
      onAudioInteraction={jest.fn()}
    />,
  );
  expect(screen.queryByRole('button', { name: 'Playback settings' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '~20s behind' }));
  expect(video.currentTime).toBeCloseTo(139.9);
});

test('offers manifest qualities with Auto selected by default', async () => {
  const video = makeVideo();
  const hls = new Hls();
  render(
    <PlayerControls
      video={video}
      hls={hls}
      playing
      onPlay={jest.fn()}
      onAudioInteraction={jest.fn()}
    />,
  );
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Playback settings' })));
  const initialItems = screen.getAllByRole('menuitem');
  expect(initialItems.map(item => item.textContent?.trim())).toEqual(['Auto', '1080p', '720p']);
  const autoItem = screen.getByText('Auto').closest('li');
  expect(autoItem).toHaveClass('ant-dropdown-menu-item-selected');
  expect(autoItem?.querySelector('[data-icon="check"]')).toBeInTheDocument();
  await act(async () => fireEvent.click(screen.getByText('720p')));
  expect(hls.currentLevel).toBe(0);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Playback settings' })));
  const selectedQuality = screen.getByText('720p').closest('li');
  expect(selectedQuality).toHaveClass('ant-dropdown-menu-item-selected');
  expect(selectedQuality?.querySelector('[data-icon="check"]')).toBeInTheDocument();
});

test('exposes latency settings, respects viewer overrides, and changes catch-up without reloading', async () => {
  const view = render(<HlsJsPlayer source={source} title="Stream" online />);
  const video = screen.getByLabelText('Stream') as HTMLVideoElement;
  jest.spyOn(video, 'paused', 'get').mockReturnValue(false);
  const hls = latestEngine();
  fireEvent.play(video);
  fireEvent.playing(video);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Playback settings' })));
  const lowLatency = screen.getByRole('switch', { name: 'Low latency' });
  const catchUp = screen.getByRole('switch', { name: 'Catch up to live' });
  expect(lowLatency).toBeChecked();
  expect(catchUp).not.toBeChecked();
  expect(screen.getByRole('separator')).toBeInTheDocument();
  expect(screen.getByText('Auto').closest('li')).toHaveClass('ant-dropdown-menu-item-selected');
  const stall = { fatal: false, details: Hls.ErrorDetails.BUFFER_STALLED_ERROR };
  act(() => {
    hls.trigger(Hls.Events.ERROR, stall);
    hls.trigger(Hls.Events.ERROR, stall);
    jest.advanceTimersByTime(1000);
  });
  expect(lowLatency).toBeChecked();
  expect(hls.config.lowLatencyMode).toBe(true);
  await act(async () => fireEvent.click(lowLatency));
  expect(lowLatency).not.toBeChecked();
  expect(catchUp).toBeDisabled();
  expect(screen.getByText('Live')).toBeInTheDocument();
  await act(async () => fireEvent.click(lowLatency));
  expect(hls.config.lowLatencyMode).toBe(true);
  expect(catchUp).toBeEnabled();
  act(() => {
    hls.trigger(Hls.Events.ERROR, stall);
    hls.trigger(Hls.Events.ERROR, stall);
    jest.advanceTimersByTime(1000);
  });
  expect(lowLatency).toBeChecked();
  expect(hls.config.lowLatencyMode).toBe(true);
  await act(async () => fireEvent.click(catchUp));
  expect(catchUp).toBeChecked();
  expect(hls.config.maxLiveSyncPlaybackRate).toBe(1.03);
  video.playbackRate = 1.03;
  await act(async () => fireEvent.click(catchUp));
  expect(hls.config.maxLiveSyncPlaybackRate).toBe(1);
  expect(video.playbackRate).toBe(1);
  await act(async () => fireEvent.click(catchUp));
  video.playbackRate = 1.03;
  await act(async () => fireEvent.click(lowLatency));
  expect(video.playbackRate).toBe(1);
  expect(hls.config.lowLatencyMode).toBe(false);
  expect(hls.currentLevel).toBe(-1);
  expect(Hls).toHaveBeenCalledTimes(1);
  expect(hls.loadSource).toHaveBeenCalledTimes(1);
  view.rerender(<HlsJsPlayer source="/another.m3u8" title="Stream" online />);
  expect(latestEngine().config.lowLatencyMode).toBe(false);
  expect(latestEngine().config.maxLiveSyncPlaybackRate).toBe(1.03);
});

test('offers latency settings for single-rendition streams', async () => {
  render(<HlsJsPlayer source={source} title="Stream" online />);
  latestEngine().levels = [{ height: 720, bitrate: 2_000_000 }];
  act(() => jest.advanceTimersByTime(1000));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Playback settings' })));
  expect(screen.getByRole('switch', { name: 'Low latency' })).toBeChecked();
  expect(screen.getByRole('switch', { name: 'Catch up to live' })).toBeEnabled();
});

test('falls back to muted autoplay and only shows the large unmute overlay for automatic mute', async () => {
  (HTMLMediaElement.prototype.play as jest.Mock).mockRejectedValueOnce(
    new DOMException('Blocked', 'NotAllowedError'),
  );
  render(<HlsJsPlayer source={source} title="Stream" online autoplay={AutoplaySetting.Always} />);
  const video = screen.getByLabelText('Stream') as HTMLVideoElement;
  await act(async () => {});
  expect(video.play).toHaveBeenCalledTimes(2);
  expect(video.muted).toBe(true);
  fireEvent.playing(video);
  expect(screen.getAllByRole('button', { name: 'Unmute' })).toHaveLength(2);
  fireEvent.click(screen.getAllByRole('button', { name: 'Unmute' })[0]);
  fireEvent.volumeChange(video);
  expect(video.muted).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
  fireEvent.volumeChange(video);
  expect(screen.getAllByRole('button', { name: 'Unmute' })).toHaveLength(1);
  expect(localStorage.getItem('owncast_volume')).toBe('0');
});

test('restores a viewer mute without a large unmute overlay and respects sound-only autoplay', async () => {
  localStorage.setItem('owncast_volume', '0');
  const view = render(
    <HlsJsPlayer source={source} title="Stream" online autoplay={AutoplaySetting.SoundOnly} />,
  );
  const video = screen.getByLabelText('Stream') as HTMLVideoElement;
  await act(async () => {});
  expect(video.play).not.toHaveBeenCalled();
  expect(video.volume).toBe(0);
  fireEvent.playing(video);
  expect(screen.getAllByRole('button', { name: 'Unmute' })).toHaveLength(1);
  view.rerender(<HlsJsPlayer source={source} title="Stream" online={false} />);
  expect(screen.queryByLabelText('Stream')).not.toBeInTheDocument();
  expect(jest.getTimerCount()).toBe(0);
});
