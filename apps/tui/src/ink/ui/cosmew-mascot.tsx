/** @jsxImportSource react */
import {useEffect, useState} from 'react';
import {Text} from 'ink';
import {
  COSMEW_MASCOT_COLOR,
  COSMEW_MASCOT_FRAME_MS,
  COSMEW_MASCOT_FRAMES,
  cosmewMascotWidth,
  renderCosmewMascot,
} from '../../theme/cosmew-mascot';
import {useTheme} from '../theme';

/** Shared terminal brand mark; follows the user's animation and reduced-motion settings. */
export function CosmewMascot({width = 80, animate = true}: {width?: number; animate?: boolean}) {
  const theme = useTheme();
  const moving = animate && theme.animate;
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!moving) return;
    const timer = setInterval(
      () => setFrame(value => (value + 1) % COSMEW_MASCOT_FRAMES.length),
      COSMEW_MASCOT_FRAME_MS,
    );
    return () => clearInterval(timer);
  }, [moving]);
  const rows = renderCosmewMascot({frame, width: cosmewMascotWidth(width), reducedMotion: !moving});
  return <Text color={theme.color(COSMEW_MASCOT_COLOR)}>{rows.join('\n')}</Text>;
}
