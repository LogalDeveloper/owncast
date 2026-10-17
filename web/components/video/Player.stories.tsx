import { Meta, StoryObj } from '@storybook/nextjs';
import { CSSProperties } from 'react';
import { Provider } from 'jotai';
import { Player } from './Player';

const meta = {
  title: 'owncast/Player/Hls.js',
  component: Player,
  decorators: [
    Story => (
      <div
        style={
          {
            width: '100%',
            aspectRatio: '16 / 9',
            '--player-container-height': '100%',
          } as CSSProperties
        }
      >
        <Provider>
          <Story />
        </Provider>
      </div>
    ),
  ],
} satisfies Meta<typeof Player>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LiveDemo: Story = {
  args: {
    source: 'https://watch.owncast.online/hls/stream.m3u8',
    title: 'Stream',
    online: true,
  },
};
