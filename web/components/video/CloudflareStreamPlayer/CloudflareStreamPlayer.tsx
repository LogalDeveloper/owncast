import { FC } from 'react';
import classNames from 'classnames';
import type { PlayerProps } from '../Player';
import { Translation } from '../../ui/Translation/Translation';
import { Localization } from '../../../types/localization';
import { AutoplaySetting, autoplayModeForSetting } from '../../../utils/autoplay';
import styles from './CloudflareStreamPlayer.module.scss';

export const CloudflareStreamPlayer: FC<PlayerProps> = ({
  source,
  online,
  initiallyMuted = false,
  autoplay = AutoplaySetting.Off,
  title,
  className,
}) => {
  // Cloudflare player options are query parameters on the iframe URL.
  const iframeSource = source ? new URL(source) : null;

  if (initiallyMuted) {
    iframeSource?.searchParams.set('muted', 'true');
  }

  // Viewer preferences override the instance's autoplay setting.
  const connection =
    typeof navigator === 'undefined'
      ? undefined
      : (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const autoplayMode = autoplayModeForSetting(autoplay, {
    prefersReducedMotion,
    saveData: connection?.saveData === true,
    startsInaudible: iframeSource?.searchParams.get('muted') === 'true',
  });

  // Cloudflare treats the autoplay parameter's presence as enabled, even if it is false.
  if (autoplayMode) {
    iframeSource?.searchParams.set('autoplay', 'true');
  } else {
    iframeSource?.searchParams.delete('autoplay');
  }

  return (
    <div className={classNames(styles.container, className)} id="player">
      {!source && (
        <div role="alert">
          <Translation
            translationKey={Localization.Frontend.Player.playbackError}
            defaultText="Unable to play this stream in this browser."
          />
        </div>
      )}

      {source && online && (
        <iframe
          key={source}
          src={iframeSource.toString()}
          title={title}
          allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
        />
      )}
    </div>
  );
};
