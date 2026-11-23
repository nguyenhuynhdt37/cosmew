/** @jsxImportSource react */
import {useEffect, useRef, useState, type ReactNode} from 'react';
import {Text} from 'ink';
import {McpManagementError} from '@cosmew/sdk';
import type {McpCatalogItem, McpManagedServer, McpManagementAction, McpManagerSnapshot} from '@cosmew/sdk';
import {useFutrynClient, useKeymap, useTextInput} from '../../hooks';
import {useOverlay} from '../../core';
import {useTheme} from '../../theme';
import {OptionList, Panel, SearchBox, TextLine, safeText} from '../../ui';
import {Overview, ServerDetails, ServerLabel} from './components';
import {remoteUrlError, serverRow, suggestedServerName} from './presentation';
import {useDialogSize, useDialogTask, type DialogProps} from '../picker';

type Choice = {id: string; label: string; content?: ReactNode; choose: () => void};
type Form = {
  labels: string[];
  values: string[];
  at: number;
  secret?: boolean;
  finish: (values: string[]) => void;
  hints?: string[];
  validate?: (values: string[], at: number) => string | undefined;
  suggestName?: boolean;
};
type View = 'Configured' | 'Discover' | 'Recommended';
/** Presentation only: all operations use the injected SDK manager, never a process launcher. */
export function McpManagerDialog(props: DialogProps & {fallback?: ReactNode}) {
  const client = useFutrynClient();
  const {color} = useTheme();
  const router = useOverlay();
  const task = useDialogTask();
  const size = useDialogSize(props);
  const [snapshot, setSnapshot] = useState<McpManagerSnapshot>();
  const [loadError, setLoadError] = useState(false);
  const [view, setView] = useState<View>('Configured');
  const [entries, setEntries] = useState<McpCatalogItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [lastQuery, setLastQuery] = useState('');
  const [selected, setSelected] = useState<McpManagedServer>();
  const [catalog, setCatalog] = useState<McpCatalogItem>();
  const [toolsView, setToolsView] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [adding, setAdding] = useState(false);
  const [problemsView, setProblemsView] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [form, setForm] = useState<Form>();
  const [confirmation, setConfirmation] = useState<{action: McpManagementAction; summary: string}>();
  const [message, setMessage] = useState('');
  const [noticeTone, setNoticeTone] = useState<'info' | 'success' | 'error'>('info');
  const [query, setQuery] = useState('');
  const [filtering, setFiltering] = useState(false);
  const [progress, setProgress] = useState('');
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void client
      .mcpManager()
      .then(result => {
        if (mounted.current) setSnapshot(result);
      })
      .catch(() => {
        if (mounted.current) setLoadError(true);
      });
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, [client]);
  const run = (action: McpManagementAction) => {
    if (controller.current) return;
    setMessage('');
    if (action.type === 'search') setLastQuery(action.query);
    setProgress(`${action.type}…`);
    const operation = new AbortController();
    controller.current = operation;
    void task.run(async signal => {
      const abort = () => operation.abort();
      signal.addEventListener('abort', abort, {once: true});
      try {
        const result = await client.manageMcp(action, operation.signal);
        if (!mounted.current) return;
        // Snapshot remains authoritative even after cancellation: the operation may have completed.
        setSnapshot(result.snapshot);
        if (operation.signal.aborted) {
          setMessage('Cancelled. Check current state before retrying.');
          return;
        }
        setNoticeTone('success');
        setMessage(result.message ?? 'Done.');
        if (result.entries) {
          setEntries(result.entries);
          setNextCursor(result.nextCursor);
          setCursor(0);
          setCatalog(undefined);
        }
        if (result.logout)
          setMessage(
            `Local credentials: ${result.logout.localCleared ? 'cleared' : 'not cleared'}; remote revocation: ${result.logout.remoteStatus}.`,
          );
        if (action.type === 'add' || action.type === 'install') setAdding(false);
        if (action.type === 'add' || action.type === 'install' || action.type === 'remove') {
          setAdvanced(false);
          setToolsView(false);
          setQuery('');
          setFiltering(false);
        }
        setSelected(current =>
          result.snapshot.servers.find(
            server =>
              server.name === (action.type === 'add' || action.type === 'install' ? action.name : current?.name),
          ),
        );
      } catch (error) {
        if (action.type === 'login' && !operation.signal.aborted && mounted.current) {
          const latest = await client.mcpManager().catch(() => undefined);
          if (latest && mounted.current && !operation.signal.aborted) {
            setSnapshot(latest);
            setSelected(selected => latest.servers.find(server => server.name === selected?.name));
          }
        }
        if (mounted.current) {
          setNoticeTone('error');
          setMessage(
            operation.signal.aborted
              ? 'Cancelled. Check current state before retrying.'
              : error instanceof McpManagementError
                ? safeText(error.message)
                : 'MCP action failed. Open Connection diagnostics for details.',
          );
        }
      } finally {
        signal.removeEventListener('abort', abort);
        controller.current = null;
        if (mounted.current) setProgress('');
      }
    });
  };
  const refresh = () => {
    if (controller.current) return;
    const operation = new AbortController();
    controller.current = operation;
    setProgress('Refreshing status…');
    setMessage('');
    void task.run(async () => {
      try {
        const latest = await client.mcpManager();
        if (!mounted.current) return;
        setSnapshot(latest);
        setLoadError(false);
        setSelected(current => latest.servers.find(server => server.name === current?.name));
        setNoticeTone('info');
        setMessage(
          operation.signal.aborted
            ? 'Cancelled. Check current state before retrying.'
            : 'Status refreshed. Use Connect or Reconnect to check a live connection.',
        );
      } catch {
        if (mounted.current) {
          setNoticeTone('error');
          setMessage('Could not refresh status. Try again.');
        }
      } finally {
        controller.current = null;
        if (mounted.current) setProgress('');
      }
    });
  };
  const ask = (action: McpManagementAction, summary: string) => {
    setConfirmation({action, summary});
    setCursor(0);
  };
  const input = (
    labels: string[],
    finish: Form['finish'],
    secret = false,
    initial?: string[],
    guidance?: Pick<Form, 'hints' | 'validate' | 'suggestName'>,
  ) => {
    setMessage('');
    setNoticeTone('info');
    setForm({labels, values: initial ?? labels.map(() => ''), at: 0, finish, secret, ...guidance});
    setCursor(0);
  };
  const switchView = (next: View) => {
    if (task.busy) return;
    setToolsView(false);
    setProblemsView(false);
    setQuery('');
    setFiltering(false);
    setAdvanced(false);
    setAdding(false);
    setView(next);
    setSelected(undefined);
    setCatalog(undefined);
    setEntries([]);
    setNextCursor(undefined);
    setCursor(0);
    setMessage('');
    if (next === 'Recommended') run({type: 'recommended'});
    if (next === 'Discover') input(['Search official registry'], values => run({type: 'search', query: values[0]!}));
  };
  const nameError = (name: string) => {
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(name))
      return 'Use 1–32 letters, digits, underscores or hyphens for the server name.';
    if (snapshot?.servers.some(server => server.name === name))
      return 'That server name already exists. Choose another name or edit the existing server.';
  };
  const manual = (transport: 'http' | 'stdio') => {
    if (transport === 'http') {
      input(
        ['Server URL', 'Server name'],
        values => {
          const url = new URL(values[0]!).href;
          ask(
            {type: 'add', name: values[1]!, config: {transport, url}},
            `Add remote ${values[1]} at ${url}? No download.`,
          );
        },
        false,
        undefined,
        {
          hints: [
            'Paste the MCP endpoint, for example https://developers.openai.com/mcp',
            'A local label for this connection. A name is suggested from the URL; you can change it.',
          ],
          suggestName: true,
          validate: (values, at) => (at === 0 ? remoteUrlError(values[0]!) : nameError(values[1]!)),
        },
      );
    } else {
      input(
        ['Server name', 'Local executable', 'Arguments as JSON array (or empty)'],
        values => {
          const args = values[2] ? (JSON.parse(values[2]) as string[]) : [];
          ask(
            {type: 'add', name: values[0]!, config: {transport, command: values[1]!, args}},
            `Add local ${values[0]}: ${values[1]} ${args.join(' ')}? Connecting starts this executable.`,
          );
        },
        false,
        undefined,
        {
          hints: [
            'A short label, for example local-docs',
            'The program to start, for example node or npx',
            'For example ["/path/to/server.js"]. Leave empty for no arguments.',
          ],
          validate: (values, at) => {
            if (at === 0) return nameError(values[0]!);
            if (at === 1 && !values[1]?.trim()) return 'Enter the executable to start.';
            if (at === 2) {
              try {
                const args: unknown = values[2] ? JSON.parse(values[2]) : [];
                if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) throw new Error();
              } catch {
                return 'Arguments must be a JSON array of strings, for example ["--port", "3000"].';
              }
            }
          },
        },
      );
    }
  };
  const edit = (server: McpManagedServer) => {
    let endpoint = '';
    if (server.transport === 'http' && server.endpoint) {
      try {
        const url = new URL(server.endpoint);
        if (!url.username && !url.password && !url.search && !url.hash) endpoint = url.href;
      } catch {
        /* Redacted or unavailable endpoint: request explicit replacement. */
      }
    }
    input(
      server.transport === 'http'
        ? ['Replacement HTTP endpoint (no credentials)']
        : ['Replacement local executable', 'Replacement arguments as JSON array (or empty)'],
      values => {
        try {
          if (server.transport === 'http') {
            const url = new URL(values[0]!);
            if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
              throw new Error();
            ask(
              {type: 'edit', name: server.name, config: {transport: 'http', url: url.href, enabled: server.enabled}},
              `Replace ${server.name} endpoint with ${url.href}? Old headers are cleared; stored credential handling follows host policy.`,
            );
          } else {
            const args: unknown = values[1] ? JSON.parse(values[1]) : [];
            if (!values[0] || !Array.isArray(args) || !args.every(arg => typeof arg === 'string')) throw new Error();
            ask(
              {
                type: 'edit',
                name: server.name,
                config: {transport: 'stdio', command: values[0]!, args, enabled: server.enabled},
              },
              `Replace ${server.name} with ${values[0]} ${args.join(' ')}? Old environment is cleared. Managed installation ownership may be removed. Connecting starts this executable.`,
            );
          }
        } catch {
          setMessage('Invalid replacement. Use a credential-free HTTP URL or executable and JSON string arguments.');
        }
      },
      false,
      server.transport === 'http' ? [endpoint] : ['', ''],
    );
  };
  const bearerChoice = (server: McpManagedServer): Choice => ({
    id: 'credential',
    label: 'Set bearer credential (masked)',
    choose: () =>
      input(
        ['Bearer credential'],
        values =>
          ask(
            {
              type: 'credentials',
              name: server.name,
              bearer: values[0]!,
              ...(server.endpoint ? {expectedEndpoint: server.endpoint} : {}),
            },
            `Replace secure credential for ${server.name}?`,
          ),
        true,
      ),
  });
  const authenticationChoice = (server: McpManagedServer): Choice => ({
    id: 'authenticate',
    label: server.auth.method === 'github-pat' ? 'Set GitHub personal access token' : 'Authenticate in browser',
    choose: () => {
      if (server.auth.method !== 'github-pat') {
        run({type: 'login', name: server.name});
        return;
      }
      input(
        ['GitHub personal access token'],
        values => ask({type: 'login', name: server.name, bearer: values[0]!}, `Save GitHub token for ${server.name}?`),
        true,
      );
    },
  });
  const advancedChoices = (server: McpManagedServer): Choice[] => [
    ...(server.transport === 'http'
      ? [
          authenticationChoice(server),
          {id: 'logout', label: 'Log out', choose: () => run({type: 'logout', name: server.name})},
          ...(server.auth.method === 'github-pat' ? [] : [bearerChoice(server)]),
          {
            id: 'clear',
            label: 'Clear bearer credential',
            choose: () =>
              ask(
                {type: 'credentials', name: server.name, bearer: null},
                `Clear secure credential for ${server.name}?`,
              ),
          },
        ]
      : []),
    ...(server.installation.id
      ? []
      : [
          {
            id: 'edit',
            label: server.transport === 'http' ? 'Edit remote endpoint' : 'Replace local executable / arguments',
            choose: () => edit(server),
          },
        ]),
    {id: 'doctor', label: 'Check connection / diagnostics', choose: () => run({type: 'doctor', name: server.name})},
    {
      id: 'remove',
      label: 'Remove server',
      choose: () =>
        ask(
          {type: 'remove', name: server.name},
          `Remove ${server.name} and its exclusively owned installation? Local credentials may be cleared and remote sign-out may be attempted.`,
        ),
    },
  ];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = (...values: (string | undefined)[]) =>
    !normalizedQuery || values.some(value => value?.toLocaleLowerCase().includes(normalizedQuery));
  const filteredServers = (snapshot?.servers ?? []).filter(server =>
    matches(server.name, server.endpoint, server.transport, server.source),
  );
  const filteredTools = (selected?.tools ?? []).filter(tool => matches(tool.name, tool.description));
  const canFilter =
    view === 'Configured' &&
    !adding &&
    !advanced &&
    !problemsView &&
    !form &&
    !confirmation &&
    (!selected || toolsView);
  const configuredChoices = (): Choice[] =>
    selected
      ? advanced
        ? advancedChoices(selected)
        : [
            {
              id: 'tools',
              label: `View tools (${selected.toolCount})`,
              choose: () => {
                setToolsView(true);
                setQuery('');
                setFiltering(false);
                setCursor(0);
              },
            },
            {
              id: 'reconnect',
              label: selected.connection === 'stopped' ? 'Connect' : 'Reconnect',
              choose: () => run({type: 'reconnect', name: selected.name}),
            },
            {
              id: 'enabled',
              label: selected.enabled ? 'Disable' : 'Enable',
              choose: () => run({type: selected.enabled ? 'disable' : 'enable', name: selected.name}),
            },
            ...(selected.transport === 'http' && ['needs-login', 'expired'].includes(selected.auth.state)
              ? selected.auth.method === 'github-pat'
                ? [authenticationChoice(selected)]
                : [
                    ...([
                      'metadata-unavailable',
                      'metadata-invalid',
                      'client-registration-required',
                      'unsupported-flow',
                    ].some(issue => issue === selected.auth.issue)
                      ? []
                      : [authenticationChoice(selected)]),
                    bearerChoice(selected),
                  ]
              : []),
            {
              id: 'diagnostics',
              label: 'Connection diagnostics',
              choose: () => run({type: 'doctor', name: selected.name}),
            },
            {
              id: 'advanced',
              label: 'Advanced settings',
              choose: () => {
                setAdvanced(true);
                setCursor(0);
                setMessage('');
              },
            },
          ]
      : adding
        ? [
            {id: 'remote', label: 'Remote server (HTTP URL)', choose: () => manual('http')},
            {id: 'local', label: 'Local server (stdio executable)', choose: () => manual('stdio')},
          ]
        : [
            ...filteredServers.map(server => ({
              id: `server:${server.name}`,
              label: serverRow(server),
              content: (
                <ServerLabel
                  server={server}
                  nameWidth={Math.min(32, Math.max(0, ...filteredServers.map(item => item.name.length)))}
                />
              ),
              choose: () => {
                setSelected(server);
                setQuery('');
                setFiltering(false);
                setAdvanced(false);
                setCursor(0);
                setMessage('');
              },
            })),
            {
              id: 'add',
              label: 'Add server…',
              choose: () => {
                setAdding(true);
                setCursor(0);
                setMessage('');
              },
            },
            {id: 'discover', label: 'Browse MCP registry…', choose: () => switchView('Discover')},
            {id: 'recommended', label: 'Recommended servers…', choose: () => switchView('Recommended')},
            {id: 'refresh', label: 'Refresh status', choose: refresh},
            ...(snapshot?.problems.length
              ? [
                  {
                    id: 'problems',
                    label: `Configuration diagnostics (${snapshot.problems.length})`,
                    choose: () => {
                      setProblemsView(true);
                      setCursor(0);
                      setQuery('');
                      setFiltering(false);
                      setMessage('');
                    },
                  },
                ]
              : []),
          ];
  const choices: Choice[] = problemsView
    ? (snapshot?.problems ?? []).map((problem, index) => ({
        id: String(index),
        label: problem,
        choose: () => {
          setNoticeTone('error');
          setMessage(problem);
        },
      }))
    : toolsView && selected && !confirmation
      ? filteredTools.map(tool => ({
          id: tool.name,
          label: tool.name,
          choose: () => {
            setNoticeTone('info');
            setMessage(tool.description.slice(0, 2000) || 'No description supplied.');
          },
        }))
      : confirmation
        ? [
            {
              id: 'cancel',
              label: 'Cancel',
              choose: () => {
                setConfirmation(undefined);
                setCursor(0);
              },
            },
            {
              id: 'confirm',
              label: 'Confirm',
              choose: () => {
                const action = confirmation.action;
                setConfirmation(undefined);
                setCursor(0);
                run(action);
              },
            },
          ]
        : view === 'Configured'
          ? configuredChoices()
          : catalog
            ? catalog.recipes.map((recipe, index) => ({
                id: String(index),
                label:
                  recipe.kind === 'npm'
                    ? `Install ${recipe.packageName}@${recipe.version}`
                    : recipe.kind === 'remote'
                      ? `Add remote ${recipe.url}`
                      : `Manual setup: ${recipe.reason}`,
                choose: () => {
                  if (recipe.kind === 'manual') {
                    setMessage('Use MCP servers → Add server, then choose remote URL or local executable.');
                    return;
                  }
                  input(['Server name'], values => {
                    const name = values[0]!;
                    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(name)) {
                      setMessage('Invalid server name. Use 1–32 letters, digits, underscores or hyphens.');
                      return;
                    }
                    if (recipe.kind === 'remote')
                      ask(
                        {
                          type: 'add',
                          name,
                          config: {transport: 'http', url: recipe.url},
                          source: view === 'Recommended' ? 'recommended' : 'registry',
                          catalogId: catalog.id,
                        },
                        `Add ${name} at ${recipe.url}? No download.`,
                      );
                    else
                      ask(
                        {
                          type: 'install',
                          name,
                          packageName: recipe.packageName,
                          version: recipe.version,
                          ...(recipe.integrity ? {integrity: recipe.integrity} : {}),
                          ...(recipe.bin ? {bin: recipe.bin} : {}),
                          catalogId: catalog.id,
                        },
                        `Install ${recipe.packageName}@${recipe.version} as ${name} in the private managed area? Integrity: ${recipe.integrity ?? 'host must resolve and verify'}. This downloads and may start the local server.`,
                      );
                  });
                },
              }))
            : [
                ...(view === 'Discover'
                  ? [
                      {
                        id: 'search',
                        label: 'Search registry',
                        choose: () =>
                          input(['Search official registry'], values => run({type: 'search', query: values[0]!})),
                      },
                    ]
                  : []),
                ...entries.map(entry => ({
                  id: entry.id,
                  label: `${entry.name} · ${entry.tested ? 'Cosmew-tested' : 'Not compatibility tested'}`,
                  choose: () => {
                    setCatalog(entry);
                    setCursor(0);
                  },
                })),
                ...(view === 'Discover' && nextCursor
                  ? [
                      {
                        id: 'next-page',
                        label: 'Next page',
                        choose: () => run({type: 'search', query: lastQuery, cursor: nextCursor}),
                      },
                    ]
                  : []),
              ];
  const close = () => {
    if (controller.current) {
      controller.current.abort();
      setProgress('Cancelling… waiting for cleanup');
      return;
    }
    if (filtering || query) {
      setFiltering(false);
      setQuery('');
      setCursor(0);
      return;
    }
    if (problemsView) {
      setProblemsView(false);
      setCursor(0);
      setMessage('');
      return;
    }
    if (form) {
      setForm(undefined);
      return;
    }
    if (confirmation) {
      setConfirmation(undefined);
      setCursor(0);
      return;
    }
    if (toolsView) {
      setToolsView(false);
      setCursor(0);
      setMessage('');
      return;
    }
    if (advanced) {
      setAdvanced(false);
      setCursor(0);
      setMessage('');
      return;
    }
    if (adding) {
      setAdding(false);
      setCursor(0);
      setMessage('');
      return;
    }
    if (selected || catalog) {
      setSelected(undefined);
      setCatalog(undefined);
      setCursor(0);
      return;
    }
    if (view !== 'Configured') {
      switchView('Configured');
      return;
    }
    router.close();
  };
  useKeymap({
    previous: () => {
      if (!task.busy && !form) setCursor(n => Math.max(0, n - 1));
    },
    next: () => {
      if (!task.busy && !form) setCursor(n => Math.max(0, Math.min(choices.length - 1, n + 1)));
    },
    close,
    submit: () => {
      if (task.busy) return;
      if (filtering) {
        setFiltering(false);
        return;
      }
      if (form) {
        const error = form.validate?.(form.values, form.at);
        if (error) {
          setNoticeTone('error');
          setMessage(error);
          return;
        }
        setMessage('');
        if (form.at + 1 < form.labels.length) {
          const values = [...form.values];
          if (form.suggestName && form.at === 0 && !values[1])
            values[1] = suggestedServerName(values[0]!, snapshot?.servers.map(server => server.name) ?? []);
          setForm({...form, values, at: form.at + 1});
        } else {
          for (let at = 0; at < form.labels.length; at++) {
            const error = form.validate?.(form.values, at);
            if (error) {
              setForm({...form, at});
              setNoticeTone('error');
              setMessage(error);
              return;
            }
          }
          setForm(undefined);
          form.finish(form.values);
        }
      } else choices[cursor]?.choose();
    },
  });
  useTextInput((text, key) => {
    if (task.busy || key.eventType === 'release' || key.ctrl || key.meta || key.escape || key.return) return;
    if (form) {
      if (key.tab) {
        setMessage('');
        setForm(current =>
          current
            ? {...current, at: (current.at + (key.shift ? current.labels.length - 1 : 1)) % current.labels.length}
            : current,
        );
        return;
      }
      if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
      setForm(current => {
        if (!current) return current;
        const values = [...current.values];
        values[current.at] =
          key.backspace || key.delete
            ? Array.from(values[current.at]!).slice(0, -1).join('')
            : (values[current.at] + safeText(text).replace(/\n/g, '')).slice(0, 4096);
        return {...current, values};
      });
    } else if (!confirmation) {
      if (filtering && canFilter) {
        if (key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
        setQuery(value =>
          key.backspace || key.delete
            ? Array.from(value).slice(0, -1).join('')
            : (value + safeText(text).replace(/\n/g, '')).slice(0, 256),
        );
        setCursor(0);
        return;
      }
      if (text === '/' && canFilter) {
        setFiltering(true);
        setCursor(0);
        return;
      }
      if (text === 'f' && !form) {
        refresh();
        return;
      }
      if (text === 'a' && view === 'Configured' && !selected && !adding && !problemsView) {
        setAdding(true);
        setCursor(0);
        setMessage('');
        return;
      }
      if (key.tab) switchView(view === 'Configured' ? 'Discover' : view === 'Discover' ? 'Recommended' : 'Configured');
      else if (text === 'c') switchView('Configured');
      else if (text === 'd') switchView('Discover');
      else if (text === 'r') switchView('Recommended');
    }
  });
  if (snapshot && !snapshot.supported && props.fallback) return props.fallback;
  const room = Math.max(1, Math.min(size.visibleRows, selected ? 6 : 10));
  const first = Math.max(0, cursor - room + 1);
  const title = problemsView
    ? 'MCP configuration diagnostics'
    : form
      ? adding
        ? 'Add MCP server'
        : 'MCP setup'
      : confirmation
        ? 'Confirm MCP change'
        : selected
          ? toolsView
            ? `${selected.name} tools`
            : advanced
              ? `${selected.name} · Advanced settings`
              : selected.name
          : adding
            ? 'Add MCP server'
            : view === 'Configured'
              ? 'MCP servers'
              : view === 'Discover'
                ? 'MCP registry'
                : 'Recommended MCP servers';
  return (
    <Panel width={size.width}>
      <Text bold color={color('accent')}>
        {safeText(title)}
      </Text>
      {!snapshot ? (
        <TextLine color={color(loadError ? 'error' : 'info')}>
          {loadError ? 'Could not load MCP servers. Press f to retry.' : 'Loading servers…'}
        </TextLine>
      ) : null}
      {snapshot?.supported === false ? <TextLine>Management unsupported by this backend.</TextLine> : null}
      {!problemsView && snapshot?.problems.length ? (
        <TextLine
          color={color('warning')}
        >{`${snapshot.problems.length} configuration ${snapshot.problems.length === 1 ? 'issue' : 'issues'} — open Configuration diagnostics for details.`}</TextLine>
      ) : null}
      {snapshot && !selected && !adding && !problemsView && !form && !confirmation && view === 'Configured' ? (
        <>
          <Overview servers={snapshot?.servers ?? []} />
          {query ? (
            <TextLine
              color={color('foregroundMuted')}
            >{`${filteredServers.length} of ${snapshot?.servers.length ?? 0} servers`}</TextLine>
          ) : null}
          <TextLine> </TextLine>
        </>
      ) : null}
      {selected && !form && !confirmation ? (
        <>
          <ServerDetails server={selected} advanced={advanced} configPath={snapshot?.configPath ?? ''} />
          {toolsView && selected.tools.length === 0 ? (
            <TextLine>No tools discovered. Go back and connect the server first.</TextLine>
          ) : null}
          <TextLine> </TextLine>
        </>
      ) : null}
      {catalog && !form && !confirmation ? (
        <>
          <TextLine>{catalog.description}</TextLine>
          <TextLine>{`Source: ${catalog.sourceUrl ?? catalog.id} · Registry-listed: ${catalog.registryListed} · Cosmew-tested: ${catalog.tested}`}</TextLine>
          <TextLine>Registry publication is not a security or compatibility certificate.</TextLine>
        </>
      ) : null}
      {confirmation ? <TextLine color={color('warning')}>{confirmation.summary}</TextLine> : null}
      {canFilter && (filtering || query) ? (
        <SearchBox
          value={query}
          placeholder={toolsView ? 'Filter tools by name or description…' : 'Filter servers by name, URL or source…'}
          width={size.width - 4}
          focused={filtering}
        />
      ) : null}
      {toolsView && query ? (
        <TextLine
          color={color('foregroundMuted')}
        >{`${filteredTools.length} of ${selected?.tools.length ?? 0} tools`}</TextLine>
      ) : null}
      {canFilter && query && (toolsView ? filteredTools.length === 0 : filteredServers.length === 0) ? (
        <TextLine color={color('warning')}>No matches. Press Esc to clear the filter.</TextLine>
      ) : null}
      {form ? (
        <>
          {form.labels.map((label, index) => (
            <TextLine
              key={label}
            >{`${index === form.at ? '❯' : ' '} ${label}: ${form.secret ? '•'.repeat(Math.min(form.values[index]!.length, 48)) : form.values[index]}${index === form.at ? '▏' : ''}`}</TextLine>
          ))}
          {form.hints?.[form.at] ? <TextLine>{form.hints[form.at]!}</TextLine> : null}
        </>
      ) : (
        <OptionList
          width={size.width - 4}
          items={choices.slice(first, first + room).map(choice => ({...choice, numbered: !!confirmation}))}
          cursor={cursor - first}
          onCursorChange={n => setCursor(first + n)}
          isActive={!task.busy}
        />
      )}
      {!form && choices.length > first + room ? (
        <TextLine>{`  ↓ ${choices.length - first - room} more`}</TextLine>
      ) : null}
      {message ? <TextLine color={color(noticeTone)}>{message}</TextLine> : null}
      {progress ? <TextLine color={color('info')}>{progress}</TextLine> : null}
      <TextLine> </TextLine>
      {!form && !confirmation && !task.busy ? (
        <TextLine color={color('foregroundMuted')}>
          {canFilter
            ? '/ filter · f refresh status' + (!selected ? ' · a add · d registry · r recommended' : '')
            : 'f refresh status'}
        </TextLine>
      ) : null}
      <TextLine color={color('foregroundMuted')}>
        {filtering
          ? 'Type to filter · Enter to finish · Esc to clear'
          : form
            ? `Enter to ${form.at + 1 === form.labels.length ? 'review' : 'continue'} · Tab / Shift+Tab to switch fields · Esc to back`
            : `↑/↓ to navigate · Enter to ${selected || adding || catalog || confirmation || view !== 'Configured' ? 'select' : 'view'} · Esc to ${task.busy ? 'cancel' : !selected && !adding && !catalog && !confirmation && !problemsView && view === 'Configured' ? 'close' : 'back'}`}
      </TextLine>
    </Panel>
  );
}
