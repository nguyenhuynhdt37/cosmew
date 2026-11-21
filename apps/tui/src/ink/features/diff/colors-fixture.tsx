/** @jsxImportSource react */
import {renderToString, Box} from 'ink';
import {ThemeProvider} from '../../theme';
import {ThemeEngine} from '../../../theme/theme';
import {DiffFileRow, DiffFileGroup} from './file-list';
import {DiffView} from '../../ui/diff';
function Fixture() {
  return (
    <Box flexDirection="column">
      <DiffFileRow
        file={{path: 'src/example.ts', status: 'modified', additions: 2, deletions: 1, lines: []}}
        width={60}
        selected
      />
      {(['added', 'deleted', 'renamed', 'untracked'] as const).map(status => (
        <DiffFileRow
          key={status}
          file={{path: `src/${status}.ts`, status, additions: 2, deletions: 1, lines: []}}
          width={60}
        />
      ))}
      <DiffFileGroup count={14} hidden={false} onToggle={() => {}} />
      <DiffView
        diff={'@@ -1,2 +1,2 @@\n-const old = "old";\n+const next = "new";\n context'}
        width={60}
        language="typescript"
        showHunks
      />
    </Box>
  );
}
const theme = process.argv[2] ?? 'dark';
const engine = new ThemeEngine({env: process.env, systemDarkPreference: !theme.startsWith('light')});
await engine.setTheme(theme);
const render = () =>
  renderToString(
    <ThemeProvider engine={engine}>
      <Fixture />
    </ThemeProvider>,
  );
const frame = render();
await engine.updateAppearance({syntaxHighlighting: false});
process.stdout.write(JSON.stringify({tokens: engine.getActiveTokens(), frame, plain: render()}));
