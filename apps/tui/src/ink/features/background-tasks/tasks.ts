import type {BackgroundTask, FutrynClient} from '@cosmew/sdk';

export type VisibleTask = BackgroundTask & {
  foreground?: boolean;
  waitingForPermission?: boolean;
  interrupted?: boolean;
};

export function taskStatusLabel(task: VisibleTask): string {
  if (task.interrupted) return 'interrupted';
  if (task.status === 'running' && task.waitingForPermission) return 'waiting for permission';
  return task.status;
}

/** UI projection only. Foreground children stay foreground and retain their SDK stop path. */
export function sessionTasks(client: FutrynClient): VisibleTask[] {
  if (!client.toolsEnabled()) return [];
  const background = client.backgroundTasks();
  const foreground: VisibleTask[] = client
    .subagents()
    .filter(agent => !background.some(task => task.id === agent.id))
    .map(agent => ({
      id: agent.id,
      kind: 'agent',
      foreground: !agent.background,
      description: agent.description,
      status:
        agent.status === 'completed'
          ? 'done'
          : agent.status === 'failed'
            ? 'failed'
            : agent.status === 'running'
              ? 'running'
              : 'stopped',
      startedAt: agent.createdAt,
      outputTail: (agent.summary || agent.steps.map(step => step.text ?? step.output ?? '').join('\n')).slice(-8192),
    }));
  const waiting = new Set(
    client
      .listPendingPermissions()
      .map(request => request.subagent?.agentId)
      .filter(Boolean),
  );
  return [...background, ...foreground].map(task => ({
    ...task,
    ...(task.kind === 'agent' && task.status === 'running' && waiting.has(task.id) ? {waitingForPermission: true} : {}),
    ...(task.kind === 'agent' && client.inspectSubagent(task.id)?.status === 'interrupted' ? {interrupted: true} : {}),
  }));
}
