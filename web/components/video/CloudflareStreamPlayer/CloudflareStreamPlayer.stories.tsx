import { Meta, StoryObj } from '@storybook/nextjs';
import { CloudflareStreamPlayer } from './CloudflareStreamPlayer';
import { AutoplaySetting } from '../../../utils/autoplay';

const meta = {
  title: 'owncast/Player/Cloudflare Stream',
  component: CloudflareStreamPlayer,
  args: {
    source:
      'https://customer-f33zs165nr7gyfy4.cloudflarestream.com/6b9e68b07dfee8cc2d116e4c51d6a957/iframe',
    title: 'Stream',
    online: true,
    autoplay: AutoplaySetting.Off,
  },
} satisfies Meta<typeof CloudflareStreamPlayer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PublicDemo: Story = {};

export const InitiallyMuted: Story = { args: { initiallyMuted: true } };

export const Autoplay: Story = { args: { autoplay: AutoplaySetting.Always } };

export const AutoplayWithSound: Story = { args: { autoplay: AutoplaySetting.SoundOnly } };

export const MissingConfiguration: Story = { args: { source: '' } };

export const Offline: Story = { args: { online: false } };
