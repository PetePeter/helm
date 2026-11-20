/**
 * The MCP setup snippets, run in a real cmd.exe window.
 *
 * Typing a snippet into an embedded shell raced the shell's own startup and
 * broke on multi-line input, so the snippet is written to a .cmd file and run
 * with `cmd /k` instead: every line runs in order, quotes reach cmd untouched,
 * and the window stays open to show the CLI's answer.
 *
 * The renderer chooses the text, so the main process only runs lines that
 * start like a snippet Helm generates, and never a chained or redirected one.
 */

const ALLOWED_FIRST_WORDS = new Set(['set', 'codex', 'claude', 'copilot', 'if', 'powershell']);
const CHAINING = /[&|<>]/;

function lines(command: string): string[] {
  return command.split(/\r?\n|\r/).map((line) => line.trim()).filter(Boolean);
}

export function buildCmdScript(command: string): string {
  return lines(command).map((line) => `${line}\r\n`).join('');
}

export function isAllowedSetupCommand(command: string): boolean {
  const all = lines(command);
  return all.length > 0 && all.every((line) => {
    const first = line.split(/\s+/)[0].toLowerCase();
    return ALLOWED_FIRST_WORDS.has(first) && !CHAINING.test(line);
  });
}
