/** @jsxImportSource react */
import {useState} from 'react';
import {parseMemoryCitations} from '@cosmew/sdk';
import {Box, Text} from 'ink';
import type {SubagentSummaryView, Usage} from '@cosmew/contracts';
import {useEvents, useFutrynClient, useKeymap} from '../../hooks';
import {useTheme} from '../../theme';
import {Markdown, ResultLine, TextLine, Truncate, formatElapsed, plural, safeText} from '../../ui';
import {useUiTheme} from '../../ui/ui-theme';
export function tokenTotal(usage: Usage | null): number | undefined {
  return usage?.inputTokens == null && usage?.outputTokens == null
    ? undefined
    : (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}
export function useSubagents() {
  const client = useFutrynClient();
  const [agents, setAgents] = useState(() => client.subagents());
  useEvents({reactive: () => setAgents(client.subagents()), subagent: () => setAgents(client.subagents())});
  return {agents, inspect: (id: string) => client.inspectSubagent(id), stop: (id: string) => client.stopSubagent(id)};
}
export interface SubagentsProps {
  agents: readonly SubagentSummaryView[];
  width?: number;
  isActive?: boolean;
  maxItems?: number;
  onInspect?: (id: string) => SubagentSummaryView | undefined;
  onOpenTranscript?: (agent: SubagentSummaryView) => void;
}
/** Compact tree; Enter inspects a child, Ctrl+O expands its bounded transcript. */
export function Subagents({
  agents,
  width,
  isActive = false,
  maxItems = 8,
  onInspect,
  onOpenTranscript,
}: SubagentsProps) {
  const {color} = useTheme();
  const ui = useUiTheme();
  const [index, setIndex] = useState(0);
  const [openedId, setOpenedId] = useState<string>();
  const [expanded, setExpanded] = useState(false);
  const selected = Math.min(index, Math.max(0, agents.length - 1));
  const active = agents[selected];
  const room = Math.max(1, maxItems);
  const start = Math.max(0, Math.min(agents.length - room, selected - Math.floor(room / 2)));
  const open = () => {
    if (!active) return;
    const detail = onInspect?.(active.id) ?? active;
    setOpenedId(active.id);
    onOpenTranscript?.(detail);
  };
  useKeymap(
    {
      previous: () => setIndex(Math.max(0, selected - 1)),
      next: () => setIndex(Math.min(Math.max(0, agents.length - 1), selected + 1)),
      submit: open,
      expand: () => {
        if (active) {
          setOpenedId(active.id);
          setExpanded(value => !value);
        }
      },
    },
    {isActive},
  );
  if (!agents.length) return null;
  const opened = agents.find(agent => agent.id === openedId);
  const detail = opened ? (onInspect?.(opened.id) ?? opened) : undefined;
  const memoryFiles = [
    ...new Set([
      ...(detail?.steps ?? []).flatMap(step =>
        step.kind === 'text' ? parseMemoryCitations(step.text ?? '').files : [],
      ),
      ...parseMemoryCitations(detail?.summary ?? '').files,
    ]),
  ];
  return (
    <Box width={width} flexDirection="column" minWidth={0}>
      {agents.slice(start, start + room).map((agent, at) => {
        const tokens = tokenTotal(agent.usage);
        const ended = agent.finishedAt ? Date.parse(agent.finishedAt) : Date.now();
        const seconds = Math.max(0, Math.round((ended - Date.parse(agent.createdAt)) / 1000));
        const current = agent.steps.findLast(step => step.status === 'running');
        const detail = [
          plural(agent.toolCount, 'tool use'),
          ...(tokens === undefined ? [] : [`${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens`]),
          ...(Number.isFinite(seconds) ? [formatElapsed(seconds * 1000)] : []),
        ].join(' · ');
        const outcome =
          agent.status === 'running'
            ? `${agent.background ? 'Running in the background' : 'Running…'} (${detail})${current?.toolName ? ` · ${current.toolName}` : ''}`
            : agent.status === 'completed'
              ? `Done (${detail})`
              : agent.status === 'failed'
                ? `Failed${agent.errorCode ? `: ${agent.errorCode}` : ''} (${detail})`
                : `Stopped (${detail})`;
        const picked = isActive && selected === start + at;
        return (
          <Box key={agent.id} flexDirection="column" width={width} minWidth={0}>
            <Text wrap="wrap">
              <Text
                color={
                  picked
                    ? ui.color('selected')
                    : agent.status === 'failed'
                      ? color('error')
                      : agent.status === 'running'
                        ? color('foregroundMuted')
                        : color('success')
                }
              >
                {picked ? '❯ ' : '⏺ '}
              </Text>
              <Text bold>{safeText(agent.agentType)}</Text>
              {safeText(`(${agent.description})`)}
            </Text>
            <ResultLine width={width}>
              <Text color={color(agent.status === 'failed' ? 'error' : 'foregroundMuted')} wrap="wrap">
                {safeText(`${'  '.repeat(Math.min(16, Math.max(0, agent.depth - 1)))}${outcome}`)}
              </Text>
            </ResultLine>
          </Box>
        );
      })}
      {agents.length > room ? (
        <Text color={color('foregroundMuted')}>{`     … +${agents.length - room} other agents · ↑/↓ navigate`}</Text>
      ) : null}
      {detail ? (
        <Box flexDirection="column" minWidth={0}>
          <TextLine width={width}>{`${detail.agentType} · ${detail.id} · ${detail.status}`}</TextLine>
          {(expanded ? detail.steps : detail.steps.slice(-8)).map((step, at) =>
            step.kind === 'text' ? (
              <Markdown key={at} text={parseMemoryCitations(step.text ?? '').content} width={width} />
            ) : (
              <Box key={at} flexDirection="column">
                <TextLine
                  width={width}
                  color={color(step.status === 'error' || step.status === 'denied' ? 'error' : 'foreground')}
                >{`⏺ ${step.toolName ?? 'Tool'}(${step.target ?? ''}) · ${step.status ?? 'unknown'}`}</TextLine>
                <Truncate text={`  ⎿ ${step.output ?? ''}`} width={width} maxLines={4} expanded={expanded} />
              </Box>
            ),
          )}
          {detail.summary ? <Markdown text={parseMemoryCitations(detail.summary).content} width={width} /> : null}
          {memoryFiles.length ? (
            <TextLine
              width={width}
              color={color('foregroundMuted')}
            >{`Ký ức đã dùng: ${memoryFiles.join(', ')}`}</TextLine>
          ) : null}
          <Text dimColor>Ctrl+O {expanded ? 'collapse' : 'expand'} child transcript</Text>
        </Box>
      ) : isActive ? (
        <Text dimColor>↑/↓ Select · Enter Open transcript · Ctrl+O Expand</Text>
      ) : null}
    </Box>
  );
}
