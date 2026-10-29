import { Meta, StoryObj } from '@storybook/nextjs';
import { CSSProperties } from 'react';
import { Player } from './Player';

const meta = {
  title: 'owncast/Player/Shared player',
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
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Player>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LiveDemo: Story = {
  args: {
    source:
      'https://customer-f33zs165nr7gyfy4.cloudflarestream.com/6b9e68b07dfee8cc2d116e4c51d6a957/iframe',
    title: 'Stream',
    online: true,
  },
};

export const MissingConfiguration: Story = {
  args: { source: '', title: 'Stream', online: true },
};

export const Offline: Story = {
  args: { ...LiveDemo.args, online: false },
};
