import { FC } from 'react';
import dynamic from 'next/dynamic';
import type { AutoplaySetting } from '../../utils/autoplay';

export type PlayerProps = {
  source: string;
  online: boolean;
  initiallyMuted?: boolean;
  autoplay?: AutoplaySetting;
  title: string;
  className?: string;
};

const CloudflareStreamPlayer = dynamic(
  () =>
    import('./CloudflareStreamPlayer/CloudflareStreamPlayer').then(
      module => module.CloudflareStreamPlayer,
    ),
  { ssr: false },
);

export const Player: FC<PlayerProps> = props => <CloudflareStreamPlayer {...props} />;
