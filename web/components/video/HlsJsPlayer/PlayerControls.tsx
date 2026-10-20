import { FC, useEffect, useState } from 'react';
import { Button, Dropdown, Slider, Tooltip } from 'antd';
import {
  CheckOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  MutedFilled,
  PauseOutlined,
  CaretRightFilled,
  SettingOutlined,
  SoundFilled,
  SwitcherOutlined,
} from '@ant-design/icons';
import Hls from 'hls.js';
import { useTranslation } from 'next-export-i18n';
import { useHotkeys } from 'react-hotkeys-hook';
import { Localization, LocalizationKey } from '../../../types/localization';
import { Translation } from '../../ui/Translation/Translation';
import AirplayIcon from '../airplay.svg';
import styles from './PlayerControls.module.scss';

type AppleVideo = HTMLVideoElement & {
  webkitShowPlaybackTargetPicker?: () => void;
  webkitEnterFullscreen?: () => void;
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
  webkitPresentationMode?: string;
};

type PlayerControlsProps = {
  video: HTMLVideoElement;
  hls: Hls | null;
  playing: boolean;
  onPlay: () => void;
  onAudioInteraction: () => void;
};

export const PlayerControls: FC<PlayerControlsProps> = ({
  video,
  hls,
  playing,
  onPlay,
  onAudioInteraction,
}) => {
  const { t } = useTranslation();
  const keys = Localization.Frontend.Player;
  const appleVideo = video as AppleVideo;
  const [volume, setVolume] = useState(video.muted ? 0 : video.volume);
  const [fullscreen, setFullscreen] = useState(false);
  const [inPip, setInPip] = useState(false);
  const [latency, setLatency] = useState(0);
  const [behind, setBehind] = useState(false);
  const [qualities, setQualities] = useState<Hls['levels']>([]);
  const [quality, setQuality] = useState('-1');
  const [menuOpen, setMenuOpen] = useState(false);
  const canPip =
    (document.pictureInPictureEnabled && !video.disablePictureInPicture) ||
    appleVideo.webkitSupportsPresentationMode?.('picture-in-picture');
  const canAirplay =
    'WebKitPlaybackTargetAvailabilityEvent' in window &&
    typeof appleVideo.webkitShowPlaybackTargetPicker === 'function';

  const label = (key: LocalizationKey, fallback: string) => {
    const translated = t(key);
    return translated === key ? fallback : translated;
  };

  useEffect(() => {
    const updateVolume = () => setVolume(video.muted ? 0 : video.volume);
    const updateFullscreen = () =>
      setFullscreen(document.fullscreenElement === video.parentElement);
    const updatePip = () =>
      setInPip(
        document.pictureInPictureElement === video ||
          (video as AppleVideo).webkitPresentationMode === 'picture-in-picture',
      );
    const updateStream = () => {
      const seekableEnd = video.seekable.length ? video.seekable.end(video.seekable.length - 1) : 0;
      const seconds = hls ? hls.latency : Math.max(0, seekableEnd - video.currentTime);
      const target = hls ? hls.targetLatency : 0;
      setLatency(Number.isFinite(seconds) ? seconds : 0);
      setBehind(Number.isFinite(seconds) && seconds > target + 3);
      setQualities(hls ? [...hls.levels] : []);
      setQuality(hls && !hls.autoLevelEnabled ? String(hls.manualLevel) : '-1');
    };
    updateVolume();
    updateStream();
    video.addEventListener('volumechange', updateVolume);
    video.addEventListener('enterpictureinpicture', updatePip);
    video.addEventListener('leavepictureinpicture', updatePip);
    video.addEventListener('webkitpresentationmodechanged', updatePip);
    document.addEventListener('fullscreenchange', updateFullscreen);
    hls?.on(Hls.Events.MANIFEST_PARSED, updateStream);
    hls?.on(Hls.Events.LEVELS_UPDATED, updateStream);
    const timer = window.setInterval(updateStream, 1000);
    return () => {
      window.clearInterval(timer);
      video.removeEventListener('volumechange', updateVolume);
      video.removeEventListener('enterpictureinpicture', updatePip);
      video.removeEventListener('leavepictureinpicture', updatePip);
      video.removeEventListener('webkitpresentationmodechanged', updatePip);
      document.removeEventListener('fullscreenchange', updateFullscreen);
      hls?.off(Hls.Events.MANIFEST_PARSED, updateStream);
      hls?.off(Hls.Events.LEVELS_UPDATED, updateStream);
    };
  }, [video, hls]);

  const togglePlayback = () => {
    if (video.paused) onPlay();
    else video.pause();
  };
  const changeVolume = (value: number) => {
    onAudioInteraction();
    video.muted = false;
    video.volume = Math.max(0, Math.min(1, value));
  };
  const toggleMute = () => {
    onAudioInteraction();
    if (video.muted || video.volume === 0) {
      video.muted = false;
      if (video.volume === 0) video.volume = 0.7;
    } else video.muted = true;
  };
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (video.parentElement.requestFullscreen) await video.parentElement.requestFullscreen();
      else appleVideo.webkitEnterFullscreen?.();
    } catch (error) {
      console.debug(error);
    }
  };
  const togglePip = async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (video.requestPictureInPicture) await video.requestPictureInPicture();
      else appleVideo.webkitSetPresentationMode?.(inPip ? 'inline' : 'picture-in-picture');
    } catch (error) {
      console.debug(error);
    }
  };
  const jumpToPresent = () => {
    if (!video.seekable.length) return;
    const last = video.seekable.length - 1;
    const end = video.seekable.end(last) - 0.1;
    const target = hls?.liveSyncPosition ?? end;
    if (!Number.isFinite(target)) return;
    video.currentTime = Math.max(video.seekable.start(last), Math.min(target, end));
    onPlay();
  };

  useHotkeys('space', event => {
    event.preventDefault();
    togglePlayback();
  });
  useHotkeys('f', toggleFullscreen, { enableOnContentEditable: false });
  useHotkeys('m', toggleMute, { enableOnContentEditable: false });
  useHotkeys('i', () => canPip && togglePip(), { enableOnContentEditable: false });
  useHotkeys('0', () => changeVolume(video.volume + 0.1), { enableOnContentEditable: false });
  useHotkeys('9', () => changeVolume(video.volume - 0.1), { enableOnContentEditable: false });

  const popupContainer = () => video.parentElement;
  const playLabel = playing ? label(keys.pause, 'Pause') : label(keys.play, 'Play');
  const muteLabel =
    volume === 0 ? label(Localization.Frontend.unmute, 'Unmute') : label(keys.mute, 'Mute');
  const fullscreenLabel = fullscreen
    ? label(keys.exitFullscreen, 'Exit fullscreen')
    : label(keys.fullscreen, 'Fullscreen');
  const orderedQualities = qualities
    .map((level, index) => ({ level, index }))
    .sort(
      (left, right) =>
        (right.level.height ?? 0) - (left.level.height ?? 0) ||
        right.level.bitrate - left.level.bitrate,
    );

  return (
    <div className={styles.controls} data-menu-open={menuOpen || undefined}>
      <Tooltip title={playLabel} getPopupContainer={popupContainer}>
        <Button
          type="text"
          icon={playing ? <PauseOutlined /> : <CaretRightFilled />}
          aria-label={playLabel}
          onClick={togglePlayback}
        />
      </Tooltip>
      <Tooltip title={muteLabel} getPopupContainer={popupContainer}>
        <Button
          type="text"
          icon={volume === 0 ? <MutedFilled /> : <SoundFilled />}
          aria-label={muteLabel}
          onClick={toggleMute}
        />
      </Tooltip>
      <Slider
        className={styles.volume}
        min={0}
        max={1}
        step={0.05}
        value={volume}
        onChange={changeVolume}
        tooltip={{ open: false }}
        ariaLabelForHandle={label(keys.volume, 'Volume')}
      />
      <div className={styles.gap} />
      {playing &&
        (behind ? (
          <Tooltip
            title={label(keys.jumpToLive, 'Jump to present')}
            getPopupContainer={popupContainer}
          >
            <Button type="text" className={styles.latency} onClick={jumpToPresent}>
              <span className={styles.liveIndicator} aria-hidden="true" />
              <Translation
                translationKey={keys.behind}
                defaultText="~{{seconds}}s behind"
                vars={{ seconds: Math.round(latency) }}
              />
            </Button>
          </Tooltip>
        ) : (
          <span className={styles.latency} data-at-live-edge="true">
            <span className={styles.liveIndicator} aria-hidden="true" />
            <Translation translationKey={keys.live} defaultText="Live" />
          </span>
        ))}
      {hls && (
        <Dropdown
          trigger={['click']}
          placement="topRight"
          styles={{ root: { maxHeight: 'calc(100% - 40px)', overflowY: 'auto' } }}
          getPopupContainer={popupContainer}
          open={menuOpen}
          onOpenChange={(open, info) => {
            if (info.source === 'trigger') setMenuOpen(open);
          }}
          menu={{
            selectable: true,
            selectedKeys: [quality],
            items: [
              {
                key: '-1',
                icon: quality === '-1' ? <CheckOutlined /> : undefined,
                label: <Translation translationKey={keys.auto} defaultText="Auto" />,
              },
              ...orderedQualities.map(({ level, index }) => ({
                key: String(index),
                icon: quality === String(index) ? <CheckOutlined /> : undefined,
                label:
                  level.name ||
                  (level.height ? `${level.height}p` : `${Math.round(level.bitrate / 1000)} kbps`),
              })),
            ],
            onClick: ({ key }) => {
              hls.currentLevel = Number(key);
              setQuality(key);
              setMenuOpen(false);
            },
          }}
        >
          <Button
            type="text"
            className={styles.playbackSettings}
            icon={<SettingOutlined />}
            aria-label={label(keys.settings, 'Playback settings')}
            title={label(keys.settings, 'Playback settings')}
          />
        </Dropdown>
      )}
      {canPip && (
        <Tooltip
          title={label(keys.pictureInPicture, 'Picture in picture')}
          getPopupContainer={popupContainer}
        >
          <Button
            type="text"
            icon={<SwitcherOutlined />}
            aria-label={label(keys.pictureInPicture, 'Picture in picture')}
            aria-pressed={inPip}
            disabled={video.readyState === 0}
            onClick={togglePip}
          />
        </Tooltip>
      )}
      {canAirplay && (
        <Tooltip title={label(keys.airplay, 'AirPlay')} getPopupContainer={popupContainer}>
          <Button
            type="text"
            icon={<AirplayIcon />}
            aria-label={label(keys.airplay, 'AirPlay')}
            onClick={() => appleVideo.webkitShowPlaybackTargetPicker()}
          />
        </Tooltip>
      )}
      <Tooltip title={fullscreenLabel} getPopupContainer={popupContainer}>
        <Button
          type="text"
          icon={fullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
          aria-label={fullscreenLabel}
          onClick={toggleFullscreen}
        />
      </Tooltip>
    </div>
  );
};
