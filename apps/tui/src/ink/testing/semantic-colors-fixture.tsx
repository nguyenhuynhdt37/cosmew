/** @jsxImportSource react */
import {renderToString} from 'ink';
import {ThemeEngine} from '../../theme/theme';
import {InkApp} from '../app';
import {OverlayProvider} from '../core';
import {ComposerView, useComposer} from '../features/composer';
import {SettingsDialog} from '../features/settings';
import {ThemesDialog} from '../features/themes';
import {TranscriptItem} from '../features/transcript';
import {FutrynClientProvider} from '../hooks';
import {ThemeProvider} from '../theme';
import {Markdown, Spinner} from '../ui';
import {createClientFixture} from './index';

const [mode, option] = process.argv.slice(2);
const engine = new ThemeEngine({
  env: {FORCE_COLOR: '3', NO_COLOR: option === 'no-color' ? '1' : '', COLORFGBG: mode === 'light' ? '0;15' : '15;0'},
});
if (option === 'ansi') await engine.setTheme(`${mode}-ansi`);
if (option === 'custom-palette') await engine.setTheme(mode === 'light' ? 'parchment' : 'midnight');
if (option === 'plain-code') await engine.updateAppearance({syntaxHighlighting: false});

const {client} = createClientFixture();
function Draft({value}: {value: string}) {
  const controller = useComposer({onSubmit: () => {}, initialValue: value, inputWidth: 97});
  return <ComposerView controller={controller} width={100} />;
}
function frame(content: React.ReactNode) {
  return renderToString(
    <FutrynClientProvider client={client}>
      <ThemeProvider engine={engine}>
        <OverlayProvider>{content}</OverlayProvider>
      </ThemeProvider>
    </FutrynClientProvider>,
    {columns: 100},
  );
}

const shell = {id: 'shell-0', name: 'exec_command', input: {cmd: 'echo "$HOME"\nprintf "hello"'}};
process.stdout.write(
  JSON.stringify({
    tokens: engine.getActiveTokens(),
    canvas: renderToString(<InkApp client={client} themeEngine={engine} width={100} rows={24} />, {columns: 100}),
    settings: frame(<SettingsDialog width={100} />),
    theme: frame(<ThemesDialog width={100} />),
    slashDraft: frame(<Draft value="/mo" />),
    bashDraft: frame(<Draft value="!echo hi" />),
    user: frame(<TranscriptItem item={{id: 'user', role: 'user', content: '/config syntaxHighlighting=true'}} />),
    assistant: frame(
      <TranscriptItem
        detailed
        item={{
          id: 'assistant',
          role: 'assistant',
          reasoning: 'Reasoning detail',
          content: 'Assistant reply',
          toolCalls: [shell],
          toolResults: [{name: shell.name, callId: shell.id, status: 'ok', content: 'Command output'}],
        }}
      />,
    ),
    prose: frame(<Markdown text={'# Heading\n\n**Important** `inlineCode` and [Link](https://example.com)'} />),
    code: frame(
      <Markdown
        text={
          '```sh\necho "$HOME" # note\n```\n\n```toml\nkey = true\ncount = 42\n```\n\n```js\n/* first\nsecond */\n```'
        }
      />,
    ),
    thinking: frame(<Spinner thinking verb="Thinking" elapsedMs={4000} effort="medium" animate={false} />),
  }),
);
