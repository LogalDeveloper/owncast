import { FC, useEffect, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { Button, Spin } from 'antd';
import { MutedFilled, CaretRightFilled, ReloadOutlined } from '@ant-design/icons';
import Hls from 'hls.js';
import classNames from 'classnames';
import { ErrorBoundary, getErrorMessage } from 'react-error-boundary';
import ViewerPing from '../viewer-ping';
import { VideoPoster } from '../VideoPoster/VideoPoster';
import { getLocalStorage, setLocalStorage } from '../../../utils/localStorage';
import { AutoplaySetting, autoplayModeForSetting } from '../../../utils/autoplay';
import { Localization } from '../../../types/localization';
import { isVideoPlayingAtom, clockSkewAtom } from '../../stores/ClientConfigStore';
import PlaybackMetrics from './playback-metrics';
import { ComponentError } from '../../ui/ComponentError/ComponentError';
import { Translation } from '../../ui/Translation/Translation';
import { HlsPlayer } from './HlsPlayer';
import { PlayerControls } from './PlayerControls';
import styles from './HlsJsPlayer.module.scss';

const PLAYER_VOLUME = 'owncast_volume';

export type PlayerProps = {
  source: string;
  online: boolean;
  initiallyMuted?: boolean;
  autoplay?: AutoplaySetting;
  title: string;
  className?: string;
};

export const HlsJsPlayer: FC<PlayerProps> = ({
  source,
  online,
  initiallyMuted = false,
  autoplay = AutoplaySetting.Off,
  title,
  className,
}) => {
  const [media, setMedia] = useState<{ video: HTMLVideoElement; hls: Hls | null }>(null);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [autoplayMuted, setAutoplayMuted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [lowLatency, setLowLatency] = useState(true);
  const [catchUp, setCatchUp] = useState(false);
  const setVideoPlaying = useSetAtom(isVideoPlayingAtom);
  const clockSkew = useAtomValue(clockSkewAtom);
  const metricsRef = useRef<PlaybackMetrics>(null);
  const automaticMute = useRef(false);

  useEffect(() => {
    metricsRef.current?.setClockSkew(clockSkew);
  }, [clockSkew]);

  const handleReady = (video: HTMLVideoElement, hls: Hls | null) => {
    const ping = new ViewerPing();
    const saved = getLocalStorage(PLAYER_VOLUME);
    const volume = saved === null ? 1 : Number(saved);
    const viewerMuted = saved !== null && volume === 0;
    video.volume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
    video.muted = initiallyMuted || viewerMuted;
    automaticMute.current = initiallyMuted && !viewerMuted;
    setMedia({ video, hls });
    setFailed(false);
    setWaiting(false);
    let disposed = false;

    const metrics = new PlaybackMetrics(video, hls);
    metrics.setClockSkew(clockSkew);
    metricsRef.current = metrics;

    const updateAudio = () => {
      if (!video.muted && video.volume > 0) automaticMute.current = false;
      setAutoplayMuted(automaticMute.current);
      if (!automaticMute.current) setLocalStorage(PLAYER_VOLUME, video.muted ? 0 : video.volume);
    };
    const onPlaying = () => {
      setPlaying(true);
      setVideoPlaying(true);
      setWaiting(false);
      updateAudio();
      ping.start();
    };
    const onPause = () => {
      setPlaying(false);
      setVideoPlaying(false);
      setWaiting(false);
      ping.stop();
    };
    const onWaiting = () => setWaiting(true);
    const attemptAutoplay = async () => {
      const connection = (navigator as Navigator & { connection?: { saveData?: boolean } })
        .connection;
      const mode = autoplayModeForSetting(autoplay, {
        prefersReducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
        saveData: connection?.saveData === true,
        startsInaudible: video.muted || video.volume === 0,
      });
      if (!mode || disposed) return;
      try {
        await video.play();
      } catch (error) {
        if (disposed || mode !== 'any' || (error as DOMException).name !== 'NotAllowedError')
          return;
        automaticMute.current = !viewerMuted;
        video.muted = true;
        try {
          await video.play();
        } catch {
          if (!disposed) setWaiting(false);
        }
      }
    };

    video.addEventListener('playing', onPlaying);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onPause);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('volumechange', updateAudio);
    void attemptAutoplay();

    return () => {
      disposed = true;
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onPause);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('volumechange', updateAudio);
      ping.stop();
      metrics.stop();
      metricsRef.current = null;
      setMedia(null);
      setPlaying(false);
      setVideoPlaying(false);
    };
  };

  const play = () => {
    media?.video.play().catch(error => console.debug(error));
  };
  const audioInteraction = () => {
    automaticMute.current = false;
    setAutoplayMuted(false);
  };
  const unmute = () => {
    if (!media) return;
    audioInteraction();
    media.video.muted = false;
    if (media.video.volume === 0) media.video.volume = 0.7;
  };

  return (
    <ErrorBoundary
      fallbackRender={({ error, resetErrorBoundary }) => (
        <ComponentError
          componentName="HlsJsPlayer"
          message={getErrorMessage(error)}
          retryFunction={resetErrorBoundary}
        />
      )}
    >
      <div className={classNames(styles.container, className)} id="player">
        <div className={styles.player}>
          {online && (
            <HlsPlayer
              key={revision}
              source={source}
              title={title}
              lowLatency={lowLatency}
              catchUp={catchUp}
              onReady={handleReady}
              onError={() => {
                setFailed(true);
                setWaiting(false);
              }}
            />
          )}
          {!playing && (
            <div className={styles.poster}>
              <VideoPoster online={online} initialSrc="/thumbnail.jpg" src="/thumbnail.jpg" />
            </div>
          )}
          {online && !failed && !waiting && (!playing || autoplayMuted) && (
            <button type="button" className={styles.overlay} onClick={playing ? unmute : play}>
              {playing ? <MutedFilled aria-hidden /> : <CaretRightFilled aria-hidden />}
              <span className={styles.srOnly}>
                <Translation
                  translationKey={
                    playing ? Localization.Frontend.unmute : Localization.Frontend.Player.play
                  }
                  defaultText={playing ? 'Unmute' : 'Play'}
                />
              </span>
            </button>
          )}
          {online && waiting && !failed && (
            <div className={styles.loading}>
              <Spin size="large" />
            </div>
          )}
          {online && failed && (
            <div className={styles.error} role="alert">
              <Translation
                translationKey={Localization.Frontend.Player.playbackError}
                defaultText="Unable to play this stream in this browser."
              />
              <Button
                icon={<ReloadOutlined />}
                onClick={() => {
                  setFailed(false);
                  setRevision(value => value + 1);
                }}
              >
                <Translation
                  translationKey={Localization.Frontend.Player.retry}
                  defaultText="Retry"
                />
              </Button>
            </div>
          )}
          {online && media && !failed && (
            <PlayerControls
              video={media.video}
              hls={media.hls}
              playing={playing}
              onPlay={play}
              onAudioInteraction={audioInteraction}
              onLowLatencyChange={setLowLatency}
              catchUp={catchUp}
              onCatchUpChange={setCatchUp}
            />
          )}
        </div>
      </div>
    </ErrorBoundary>
  );
};
