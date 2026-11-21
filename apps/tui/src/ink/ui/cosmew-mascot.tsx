/** @jsxImportSource react */
import {useEffect, useState} from 'react';
import {Text} from 'ink';
import {renderCosmewMascot} from '../../theme/cosmew-mascot';
import {useTheme} from '../theme';

/** Shared terminal brand mark; follows the user's animation and reduced-motion settings. */
export function CosmewMascot({width, animate = true}: {width?: number; animate?: boolean}) {
  const theme = useTheme();
  const moving = animate && theme.animate;
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!moving) return;
    const timer = setInterval(() => setFrame(value => (value + 1) % 3), 520);
    return () => clearInterval(timer);
  }, [moving]);
  const rows = renderCosmewMascot({frame, width: width !== undefined && width < 32 ? 7 : 9, reducedMotion: !moving});
  return <Text color={theme.color('accent')}>{rows.join('\n')}</Text>;
}
