import {
  DREAM_IDEA_PROMPT_MARKER,
  DREAM_IDEA_PROMPT_SECTION,
} from '../types/dreaming.js';

/** Append the current idea procedure to a non-empty saved prompt exactly once. */
export function migrateSavedDreamPrompt(prompt: unknown): string | null {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.includes(DREAM_IDEA_PROMPT_MARKER)) return null;
  const separator = prompt.endsWith('\n') ? '' : '\n\n';
  return `${prompt}${separator}${DREAM_IDEA_PROMPT_SECTION}`;
}
