/** One line for the transcript (ADR 0054); token counts are estimates. */
export function compactionNotice(event: {
  strategy: 'model' | 'excerpt';
  tokensBefore: number;
  tokensAfter: number;
  fallback?: boolean;
}): string {
  const how = event.strategy === 'model' ? 'summarized by the model' : 'excerpt checkpoint';
  return `Context compacted (${how}${event.fallback ? '; model summary failed' : ''}): ~${event.tokensBefore.toLocaleString('en-US')} -> ~${event.tokensAfter.toLocaleString('en-US')} tokens.`;
}
