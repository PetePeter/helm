/**
 * The keep-warm ping's text. Pure, so the renderer can show the default too.
 * A CLI type configures only the words; the wrapper is added at send time.
 */

/** A ping is wrapped in these so quick compact can drop the whole thing: bracket
 *  delimiters, no braces, so sequence escaping ships them byte for byte. */
export const HEARTBEAT_OPEN = '[HEARTBEAT_START]';
export const HEARTBEAT_CLOSE = '[HEARTBEAT_END]';
/** The prefix the CLI records: `{Esc}` clears half-typed input, then the ping starts. */
export const HEARTBEAT_MARKER = `{Esc}${HEARTBEAT_OPEN}`;

/** Default ping text: short housekeeping guidance. Per CLI: keepWarmPrompt. */
export const KEEP_WARM_DEFAULT_TEXT =
  'heartbeat. If context is at least 200k tokens and you have not already reminded the user since compacting, briefly suggest Helm Quick Compact; do not run it automatically. ' +
  'If any worker sessions you spawned are still in flight and you have not checked recently, consider checking their progress or whether they are stuck.';

const MARKERS = /\[HEARTBEAT_(?:START|END)\]/gi;

/**
 * What a keep-warm ping types (sequence syntax): the configured text, or the
 * default when blank, inside the fixed marker pair. Markers and a leading
 * `{Esc}` already in the text are dropped (older configs stored the whole
 * ping), and it is kept to one line so the pair always bounds a single prompt.
 */
export function buildKeepWarmPrompt(text?: string): string {
  const body = (text ?? '')
    .replace(MARKERS, '')
    .replace(/\s*\r?\n\s*/g, ' ')
    .trim()
    .replace(/^\{Esc\}\s*/i, '');
  return `${HEARTBEAT_MARKER} ${body || KEEP_WARM_DEFAULT_TEXT}${HEARTBEAT_CLOSE}`;
}
