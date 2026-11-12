/**
 * Every `{name}` a CLI type's command and action templates may use — the one
 * list Helm fills them from and the Tool editor's "placeholder help" reads.
 * Renderer-safe: no Node imports.
 */
import { isKnownSequenceToken } from '../input/sequence-parser.js';

export interface TemplatePlaceholder {
  name: string;
  meaning: string;
}

export type TemplateField =
  | 'spawnCommand' | 'resumeCommand' | 'continueCommand' | 'renameCommand' | 'headlessCommand'
  | 'clear' | 'compact' | 'export' | 'stop';

const SESSION: readonly TemplatePlaceholder[] = [
  { name: 'cliSessionName', meaning: "Helm's own UUID for this session. Stable across restarts." },
  { name: 'cliThreadId', meaning: "The CLI's own session id, reported by its hooks. Falls back to {cliSessionName} until a hook reports one." },
];

export const FIELD_PLACEHOLDERS: Readonly<Record<TemplateField, readonly TemplatePlaceholder[]>> = {
  spawnCommand: SESSION,
  resumeCommand: SESSION,
  continueCommand: SESSION,
  renameCommand: SESSION,
  headlessCommand: [
    { name: 'promptFile', meaning: 'File Helm writes the prompt into; the command reads it.' },
    { name: 'outputFile', meaning: 'File the command writes its reply to; Helm reads it.' },
  ],
  clear: [],
  compact: [{ name: 'instruction', meaning: 'Optional focus passed to compact. Empty when none is given.' }],
  export: [{ name: 'path', meaning: 'Absolute file path the CLI should write the export to.' }],
  stop: [],
};

/** Fields delivered through the sequence parser, so `{Enter}`-style keys are valid there too. */
export const SEQUENCE_FIELDS: ReadonlySet<TemplateField> = new Set<TemplateField>(['clear', 'compact', 'export', 'stop']);

/** The sequence keys "placeholder help" lists for sequence fields (full syntax: docs/config-system.md). */
export const SEQUENCE_KEY_HELP: readonly { token: string; meaning: string }[] = [
  { token: '{Enter}', meaning: 'Press Enter' },
  { token: '{Send}', meaning: "Submit with the CLI's own submit key" },
  { token: '{NoSend}', meaning: 'Do not add a final submit' },
  { token: '{Wait 500}', meaning: 'Pause for N milliseconds' },
  { token: '{Esc}', meaning: 'Escape' },
  { token: '{Tab}', meaning: 'Tab' },
  { token: '{Ctrl+C}', meaning: 'Key combo: Ctrl / Alt / Shift / Win + key' },
  { token: '{Up}', meaning: 'Arrow keys: {Up} {Down} {Left} {Right}' },
  { token: '{Backspace}', meaning: 'Editing keys: {Backspace} {Delete} {Space} {Home} {End}' },
  { token: '{F1}', meaning: 'Function keys {F1} … {F12}' },
];

/** `$name` spellings older configs used for action placeholders. */
const LEGACY_DOLLAR: Readonly<Record<string, string>> = { instruction: 'instruction', instructions: 'instruction', path: 'path' };

/**
 * Fill `{name}` for each name in `values`; anything else (unknown names, `{{`
 * escapes, sequence keys) is left exactly as typed. The legacy `$instruction`
 * / `$path` spellings are filled too — as whole tokens only, so `$pathology`
 * or a shell `$HOME` survive.
 */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  const has = (name: string) => Object.prototype.hasOwnProperty.call(values, name);
  return template
    .replace(/\{\{|\}\}|\{([A-Za-z_]\w*)\}/g, (match, name?: string) => (name && has(name) ? values[name] : match))
    .replace(/\$([A-Za-z_]\w*)/g, (match, name: string) => {
      const legacy = LEGACY_DOLLAR[name];
      return legacy && has(legacy) ? values[legacy] : match;
    });
}

/** The session ids every session command fills from. */
export function sessionTemplateValues(cliSessionName: string, cliThreadId?: string): { cliSessionName: string; cliThreadId: string } {
  return { cliSessionName, cliThreadId: cliThreadId || cliSessionName };
}

/** `{tokens}` in `template` that `field` does not fill — typos the editor flags. */
export function unknownPlaceholders(field: TemplateField, template: string): string[] {
  const known = new Set(FIELD_PLACEHOLDERS[field].map(p => p.name));
  const sequence = SEQUENCE_FIELDS.has(field);
  const tokens = [...template.replace(/\{\{|\}\}/g, '').matchAll(/\{([^{}]*)\}/g)].map(m => m[1]);
  return tokens.filter(token => !known.has(token) && !(sequence && isKnownSequenceToken(token)));
}
