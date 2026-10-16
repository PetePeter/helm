import { getCliDisplayName } from './utils.js';

export interface ChipbarTemplateContext {
  cwd: string;
  cliType: string;
  sessionName: string;
  inboxDir: string;
}

export interface ChipbarTemplateDefinition {
  token: string;
  description: string;
}

export const CHIPBAR_TEMPLATE_DEFINITIONS: ChipbarTemplateDefinition[] = [
  { token: '{cwd}', description: 'The active session working directory.' },
  { token: '{cliType}', description: 'The active session CLI type name, such as Claude Code.' },
  { token: '{sessionName}', description: 'The active session display name.' },
  { token: '{inboxDir}', description: 'The writable planner inbox folder at config/plans/incoming.' },
  { token: '{plansDir}', description: 'Alias for {inboxDir}, kept for backward compatibility.' },
];

export function resolveChipbarTemplates(sequence: string, ctx: ChipbarTemplateContext): string {
  const replacements: Record<string, string> = {
    cwd: ctx.cwd,
    // The stored cliType is a UUID identity; expanding that into prompt text
    // would be meaningless to the CLI reading it. Expand the human label.
    clitype: getCliDisplayName(ctx.cliType),
    sessionname: ctx.sessionName,
    inboxdir: ctx.inboxDir,
    plansdir: ctx.inboxDir,
  };

  let result = '';
  let i = 0;

  while (i < sequence.length) {
    if (sequence[i] === '{' && sequence[i + 1] === '{') {
      result += '{{';
      i += 2;
      continue;
    }

    if (sequence[i] === '}' && sequence[i + 1] === '}') {
      result += '}}';
      i += 2;
      continue;
    }

    if (sequence[i] !== '{') {
      result += sequence[i];
      i++;
      continue;
    }

    const closeIdx = sequence.indexOf('}', i + 1);
    if (closeIdx === -1) {
      result += sequence.slice(i);
      break;
    }

    const token = sequence.slice(i + 1, closeIdx);
    const replacement = replacements[token.toLowerCase()];
    result += replacement ?? `{${token}}`;
    i = closeIdx + 1;
  }

  return result;
}
