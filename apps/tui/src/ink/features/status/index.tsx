/** @jsxImportSource react */
import {Box} from 'ink';
import {TextLine} from '../../ui';
import {useFutrynClient, useStatus, useClientEvents} from '../../hooks';
import {useReducer} from 'react';
import {useTheme} from '../../theme';
import type {FutrynClient} from '@futryn/sdk';
export function useStatusLine(draft = '') {
  const client = useFutrynClient();
  const status = useStatus();
  const [, update] = useReducer(n => n + 1, 0);
  useClientEvents({subagent: () => update()});
  return {
    status,
    context: client.context(draft),
    usage: client.usage(),
    runningAgents: client.subagents().filter(a => a.status === 'running').length,
    branch: client.toolsEnabled() ? client.getWorkspaceDiff()?.branch : undefined,
  };
}
export interface StatusLineProps {
  status: ReturnType<FutrynClient['status']>;
  context: ReturnType<FutrynClient['context']>;
  usage: ReturnType<FutrynClient['usage']>;
  runningAgents?: number;
  branch?: string | null;
  width?: number;
}
export function StatusLine({status, context, usage, runningAgents = 0, branch, width}: StatusLineProps) {
  const {color} = useTheme();
  const full = status.sandboxMode === 'danger-full-access';
  return (
    <Box flexDirection="column" width={width}>
      <TextLine
        color={color('foregroundMuted')}
      >{`${status.selection?.modelId ?? 'No model'} · effort ${status.reasoningEffort ?? 'default'} · ${status.permissionPreset} · context ${context.estimatedPercent == null ? 'unknown' : `~${context.estimatedPercent}%`} · in ${usage.inputTokens ?? '?'} / out ${usage.outputTokens ?? '?'} · ${usage.costUSD == null ? 'cost unreported' : `est. $${usage.costUSD.toFixed(4)}`} · ${runningAgents} agents running${branch ? ` · ${branch}` : ''}`}</TextLine>
      {full && (
        <TextLine color={color('warning')}>
          Full Access: commands run without sandbox or approval; project deny rules still apply.
        </TextLine>
      )}
    </Box>
  );
}
