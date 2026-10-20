import { FC, useEffect, useRef } from 'react';
import Hls from 'hls.js';

type HlsPlayerProps = {
  source: string;
  title: string;
  onReady: (video: HTMLVideoElement, hls: Hls | null) => void | (() => void);
  onError: () => void;
};

export const HlsPlayer: FC<HlsPlayerProps> = ({ source, title, onReady, onError }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const callbacks = useRef({ onReady, onError });

  useEffect(() => {
    callbacks.current = { onReady, onError };
  }, [onReady, onError]);

  useEffect(() => {
    const video = videoRef.current;
    let hls: Hls | null = null;
    let recoveredMediaError = false;

    const nativeHlsSupported = video.canPlayType('application/vnd.apple.mpegurl') !== '';
    if (Hls.isSupported()) {
      hls = new Hls({
        autoStartLoad: false,
        lowLatencyMode: false,
        maxLiveSyncPlaybackRate: 1,
        startLevel: -1,
      });
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
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [source]);

  return <video ref={videoRef} aria-label={title} playsInline preload="none" />;
};
