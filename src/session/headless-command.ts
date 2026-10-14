/**
 * The headless command of a CLI type: the shell line that runs the CLI once,
 * with no terminal UI, for a silent recording-model pass. Pure, so the config
 * loader, the picker and the runner agree on what "can run headless" means.
 *
 * The prompt goes in through a file and the reply comes out through a file.
 * A prompt is many lines of anything; no shell quotes that reliably as an
 * argument, and a reply scraped from a terminal carries the shell's own echo.
 */

export const PROMPT_FILE_PLACEHOLDER = '{promptFile}';
export const OUTPUT_FILE_PLACEHOLDER = '{outputFile}';

type CliProvider = 'claude' | 'codex' | 'copilot';

/**
 * Built-in commands per CLI family, used when a type states none. They live in
 * code, not in the shipped cli-types.yaml, because that file only seeds a
 * fresh install: an existing install would never get them.
 *
 * The prompt is a transcript: text Helm did not write, handed to an agent.
 * So the built-in commands take the agent's hands away. Claude Code runs with
 * no tools at all and no MCP servers; Codex cannot switch its shell off, so it
 * runs in its read-only sandbox. Copilot has none: its print mode only takes
 * the prompt as an argument.
 */
export const DEFAULT_HEADLESS_COMMANDS: Partial<Record<CliProvider, string>> = {
  claude: 'claude -p --no-session-persistence --strict-mcp-config --output-format text --tools "" < "{promptFile}" > "{outputFile}"',
  codex: 'codex exec --skip-git-repo-check --ephemeral --sandbox read-only -o "{outputFile}" - < "{promptFile}"',
};

export const NO_HEADLESS_COMMAND_NOTE = 'no headless command';
export const BAD_HEADLESS_COMMAND_NOTE = `headless command needs ${PROMPT_FILE_PLACEHOLDER} and ${OUTPUT_FILE_PLACEHOLDER}`;

/** The command a CLI type runs headless: its own, else its family's built-in one. */
export function headlessCommandFor(config: { headlessCommand?: string; provider?: CliProvider | null }): string | undefined {
  return config.headlessCommand?.trim() || (config.provider ? DEFAULT_HEADLESS_COMMANDS[config.provider] : undefined);
}

/** Why a command cannot run headless; undefined when it can. */
export function headlessCommandProblem(command: string | undefined): string | undefined {
  if (!command?.trim()) return NO_HEADLESS_COMMAND_NOTE;
  if (!command.includes(PROMPT_FILE_PLACEHOLDER) || !command.includes(OUTPUT_FILE_PLACEHOLDER)) return BAD_HEADLESS_COMMAND_NOTE;
  return undefined;
}

/**
 * The files are named relative to the run's working directory, and the names
 * are Helm's own (letters, digits, dots, dashes). A full path would put the
 * user's directory names into a shell line, where `%`, `$` or a backtick in
 * one of them is code.
 */
export function fillHeadlessCommand(command: string, files: { promptFile: string; outputFile: string }): string {
  return command
    .replaceAll(PROMPT_FILE_PLACEHOLDER, files.promptFile)
    .replaceAll(OUTPUT_FILE_PLACEHOLDER, files.outputFile);
}
