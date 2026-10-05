/**
 * Format opted-in artifacts as explicit context, separately from one-shot
 * handover notes. Every matching artifact is kept in the output.
 */
export function formatManifestoContext(artifacts: Array<{ title: string; content: string }>): string {
  if (artifacts.length === 0) return '';
  return [
    'Persistent manifesto context. This content is supplied alongside any handover after session resets:',
    ...artifacts.flatMap(artifact => [`\n## ${artifact.title}`, artifact.content]),
  ].join('\n');
}

/** Add persistent context without replacing or rewriting a user handover. */
export function appendManifestoContext(handover: string | undefined, manifestoContext: string): string | undefined {
  const note = handover?.trim();
  if (!manifestoContext) return note || undefined;
  return [note, manifestoContext].filter(Boolean).join('\n\n');
}
