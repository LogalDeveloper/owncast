import { cleanup, render, screen } from '@testing-library/react';
import { Player } from '../components/video/Player';
import { CloudflareStreamPlayer } from '../components/video/CloudflareStreamPlayer/CloudflareStreamPlayer';
import { AutoplaySetting } from '../utils/autoplay';

const { CloudflareStreamPlayer: IframePlayer } = jest.requireActual<
  typeof import('../components/video/CloudflareStreamPlayer/CloudflareStreamPlayer')
>('../components/video/CloudflareStreamPlayer/CloudflareStreamPlayer');

jest.mock('../components/video/CloudflareStreamPlayer/CloudflareStreamPlayer', () => ({
  CloudflareStreamPlayer: jest.fn(() => <div data-testid="cloudflare-player" />),
}));

const props = {
  source: 'https://customer-example.cloudflarestream.com/0123456789abcdef0123456789abcdef/iframe',
  title: 'Stream',
  online: true,
  initiallyMuted: true,
  autoplay: AutoplaySetting.Always,
  className: 'player',
};

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

test('renders the Cloudflare player and forwards all props', async () => {
  render(<Player {...props} />);
  expect(await screen.findByTestId('cloudflare-player')).toBeInTheDocument();
  expect((CloudflareStreamPlayer as jest.Mock).mock.calls[0][0]).toEqual(props);
});

test.each([
  { autoplay: undefined, initiallyMuted: false, expectedAutoplay: null, expectedMuted: null },
  {
    autoplay: AutoplaySetting.Off,
    initiallyMuted: false,
    expectedAutoplay: null,
    expectedMuted: null,
  },
  {
    autoplay: AutoplaySetting.Always,
    initiallyMuted: false,
    expectedAutoplay: 'true',
    expectedMuted: null,
  },
  {
    autoplay: AutoplaySetting.Always,
    initiallyMuted: true,
    expectedAutoplay: 'true',
    expectedMuted: 'true',
  },
  {
    autoplay: AutoplaySetting.SoundOnly,
    initiallyMuted: false,
    expectedAutoplay: 'true',
    expectedMuted: null,
  },
  {
    autoplay: AutoplaySetting.SoundOnly,
    initiallyMuted: true,
    expectedAutoplay: null,
    expectedMuted: 'true',
  },
])(
  'configures iframe autoplay=$autoplay with initiallyMuted=$initiallyMuted',
  ({ autoplay, initiallyMuted, expectedAutoplay, expectedMuted }) => {
    render(<IframePlayer {...{ ...props, autoplay, initiallyMuted }} />);

    const source = new URL(screen.getByTitle(props.title).getAttribute('src'));
    expect(source.searchParams.get('autoplay')).toBe(expectedAutoplay);
    expect(source.searchParams.get('muted')).toBe(expectedMuted);
  },
);

test.each(['true', 'false'])(
  'removes existing autoplay=%s when disabled and preserves other options',
  autoplay => {
    render(
      <IframePlayer
        {...props}
        source={`${props.source}?autoplay=${autoplay}&controls=false`}
        autoplay={AutoplaySetting.Off}
      />,
    );

    const source = new URL(screen.getByTitle(props.title).getAttribute('src'));
    expect(source.searchParams.has('autoplay')).toBe(false);
    expect(source.searchParams.get('controls')).toBe('false');
  },
);

test('omits iframe autoplay when reduced motion is preferred', () => {
  jest.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
  render(<IframePlayer {...props} />);

  const source = new URL(screen.getByTitle(props.title).getAttribute('src'));
  expect(source.searchParams.has('autoplay')).toBe(false);
});
