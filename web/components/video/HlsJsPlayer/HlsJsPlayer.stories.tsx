import { StoryFn, Meta } from '@storybook/nextjs';
import { Provider } from 'jotai';
import { CSSProperties, useEffect, useRef, useState } from 'react';
import { HlsJsPlayer } from './HlsJsPlayer';
import { HlsPlayer } from './HlsPlayer';
import { PlayerControls } from './PlayerControls';
import { AutoplaySetting } from '../../../utils/autoplay';
import styles from './HlsJsPlayer.module.scss';

const streams = {
  DemoServer: `https://watch.owncast.online/hls/stream.m3u8`,
  RetroStrangeTV: `https://live.retrostrange.com/hls/stream.m3u8`,
  localhost: `http://localhost:8080/hls/stream.m3u8`,
};

const meta = {
  title: 'owncast/Player/HlsJs Player',
  component: HlsJsPlayer,
  argTypes: {
    source: {
      options: Object.keys(streams),
      mapping: streams,
      control: {
        type: 'select',
      },
    },
  },
  parameters: {},
} satisfies Meta<typeof HlsJsPlayer>;

export default meta;

const Template: StoryFn<typeof HlsJsPlayer> = args => (
  <div
    style={
      { width: '100%', aspectRatio: '16 / 9', '--player-container-height': '100%' } as CSSProperties
    }
  >
    <Provider>
      <HlsJsPlayer {...args} />
    </Provider>
  </div>
);

export const LiveDemo = {
  render: Template,

  args: {
    online: true,
    source: 'https://watch.owncast.online/hls/stream.m3u8',
    title: 'Stream title',
  },
};

export const Offline = {
  render: Template,
  args: { ...LiveDemo.args, online: false },
};

export const MutedAutoplay = {
  render: Template,
  args: { ...LiveDemo.args, autoplay: AutoplaySetting.Always, initiallyMuted: true },
};

const ControlsPreview = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [video, setVideo] = useState<HTMLVideoElement>(null);
  useEffect(() => setVideo(videoRef.current), []);
  return (
    <div className={styles.player} style={{ height: 80 }}>
      <video hidden ref={videoRef} />
      {video && (
        <PlayerControls
          video={video}
          hls={null}
          playing={false}
          onPlay={() => {}}
          onAudioInteraction={() => {}}
        />
      )}
    </div>
  );
};

export const ControlsOnly = { render: () => <ControlsPreview /> };

export const EngineOnly = {
  render: () => (
    <div className={styles.player} style={{ aspectRatio: '16 / 9' }}>
      <HlsPlayer source={streams.DemoServer} title="Stream" onReady={() => {}} onError={() => {}} />
    </div>
  ),
};
