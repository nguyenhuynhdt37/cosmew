import type {ModelInfo} from '@futryn/contracts';

export function filterModels(models: ModelInfo[], query: string): ModelInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  return models.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
}

/** Short capability tags such as `[stream,tools]`, or `[basic]` when none are advertised. */
export function capabilityTag(model: ModelInfo): string {
  const caps: string[] = [];
  if (model.capabilities.streaming === 'supported') caps.push('stream');
  if (model.capabilities.tools === 'supported') caps.push('tools');
  if (model.capabilities.reasoning === 'supported') caps.push('reason');
  if (model.capabilities.vision === 'supported') caps.push('vision');
  return caps.length > 0 ? `[${caps.join(',')}]` : '[basic]';
}
