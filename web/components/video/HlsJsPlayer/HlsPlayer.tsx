import { FC, useEffect, useRef } from 'react';
import Hls from 'hls.js';

type HlsPlayerProps = {
  source: string;
  title: string;
  lowLatency?: boolean;
  catchUp?: boolean;
  onReady: (video: HTMLVideoElement, hls: Hls | null) => void | (() => void);
  onError: () => void;
};

export const HlsPlayer: FC<HlsPlayerProps> = ({
  source,
  title,
  lowLatency = true,
  catchUp = false,
  onReady,
  onError,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const callbacks = useRef({ onReady, onError });
  const preferences = useRef({ lowLatency, catchUp });

  useEffect(() => {
    callbacks.current = { onReady, onError };
  }, [onReady, onError]);

  useEffect(() => {
    preferences.current = { lowLatency, catchUp };
  }, [lowLatency, catchUp]);

  useEffect(() => {
    const video = videoRef.current;
    let hls: Hls | null = null;
    let recoveredMediaError = false;

    const nativeHlsSupported = video.canPlayType('application/vnd.apple.mpegurl') !== '';
    if (Hls.isSupported()) {
      hls = new Hls({
        autoStartLoad: false,
        lowLatencyMode: preferences.current.lowLatency,
        maxLiveSyncPlaybackRate: preferences.current.catchUp ? 1.03 : 1,
        startLevel: -1,
      });
      hlsRef.current = hls;
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recoveredMediaError) {
          recoveredMediaError = true;
          hls.recoverMediaError();
        } else {
          callbacks.current.onError();
        }
      });
    } else if (!nativeHlsSupported) {
      callbacks.current.onError();
      return undefined;
    }

    const handleNativeError = () => callbacks.current.onError();
    let sourceLoaded = false;
    const handlePlay = () => {
      if (!hls) return;
      if (!sourceLoaded) {
        sourceLoaded = true;
        hls.loadSource(source);
      }
      hls.startLoad();
    };
    const handlePause = () => hls?.stopLoad();
    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('ended', handlePause);
    if (hls) {
      hls.attachMedia(video);
    } else {
      video.addEventListener('error', handleNativeError);
      video.src = source;
    }
    const cleanup = callbacks.current.onReady(video, hls);

    return () => {
      if (cleanup) cleanup();
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('ended', handlePause);
      video.removeEventListener('error', handleNativeError);
      hls?.destroy();
      hlsRef.current = null;
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [source]);

  useEffect(() => {
    if (!hlsRef.current) return;
    hlsRef.current.config.lowLatencyMode = lowLatency;
    if (!lowLatency) videoRef.current.playbackRate = 1;
  }, [lowLatency]);

  useEffect(() => {
    if (!hlsRef.current) return;
    hlsRef.current.config.maxLiveSyncPlaybackRate = catchUp ? 1.03 : 1;
    if (!catchUp) videoRef.current.playbackRate = 1;
  }, [catchUp]);

  return <video ref={videoRef} aria-label={title} playsInline preload="none" />;
};
