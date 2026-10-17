import { cleanup, render, screen } from '@testing-library/react';
import { Player } from '../components/video/Player';
import { HlsJsPlayer } from '../components/video/HlsJsPlayer/HlsJsPlayer';
import { AutoplaySetting } from '../utils/autoplay';

jest.mock('../components/video/HlsJsPlayer/HlsJsPlayer', () => ({
  HlsJsPlayer: jest.fn(() => <div data-testid="hls-player" />),
}));

const props = {
  source: '/hls/stream.m3u8',
  title: 'Stream',
  online: true,
  initiallyMuted: true,
  autoplay: AutoplaySetting.Always,
  className: 'player',
};

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

test('always renders the Hls.js player', async () => {
  render(<Player {...props} />);
  expect(await screen.findByTestId('hls-player')).toBeInTheDocument();
  expect((HlsJsPlayer as jest.Mock).mock.calls[0][0]).toEqual(props);
});
