import type {BackgroundTask, FutrynClient} from '@cosmew/sdk';

export type VisibleTask = BackgroundTask & {foreground?: boolean};

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
  return [...background, ...foreground];
}
