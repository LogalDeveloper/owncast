import { FC } from 'react';
import dynamic from 'next/dynamic';
import type { PlayerProps } from './HlsJsPlayer/HlsJsPlayer';

const HlsJsPlayer = dynamic(
  () => import('./HlsJsPlayer/HlsJsPlayer').then(module => module.HlsJsPlayer),
  { ssr: false },
);

export const Player: FC<PlayerProps> = props => <HlsJsPlayer {...props} />;
