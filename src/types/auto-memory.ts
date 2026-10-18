/**
 * Auto memory settings: one global recording model and the two switches.
 * Shared by main (ConfigLoader, the silent runner) and the Settings tab.
 */

export interface AutoMemorySettings {
  /** CLI type id of the model that does the recording. Empty = none picked, auto-save is inert. */
  recordingModel: string;
  /** Run the judge pass after each turn. */
  autoSave: boolean;
  /** Let the suggester hint at memories. Skill hints are unaffected. */
  autoRecall: boolean;
  /** The judge's system prompt as edited in Settings. Empty = use DEFAULT_JUDGE_PROMPT. */
  judgePrompt: string;
}

export const DEFAULT_AUTO_MEMORY_SETTINGS: AutoMemorySettings = {
  recordingModel: '',
  autoSave: true,
  autoRecall: true,
  judgePrompt: '',
};

/**
 * What the judge is told when no prompt was edited. Lives here, not with the
 * judge, so the Settings tab can show the text the user is about to change.
 */
export const DEFAULT_JUDGE_PROMPT = [
  'You are a memory judge. You are shown a transcript of a working session between a USER and another ASSISTANT.',
  'You are not part of that conversation: never answer the user and never continue the work.',
  'Decide whether the transcript holds a key memory worth saving for future sessions. You do NOT summarise it.',
  'Most turns hold nothing worth keeping, and NOTHING is the normal, correct answer.',
  '',
  'A key memory is one of:',
  '- a fact about the system (a port, a path, a setting, how two parts connect)',
  '- a decision and its reason',
  '- a fix for an error',
  '- a preference of the user',
  '',
  'Ignore: greetings, plans and progress reports, what the assistant is about to do, restated questions,',
  'file contents and command output as such, guesses, and anything in ALREADY SAVED.',
  '',
  'Never save work status. It already lives in git, plans and todos. Answer NOTHING for anything that:',
  '- names a commit hash, a plan id (P-1234), a test count, or a build result',
  '- says something was committed, pushed, approved, queued, claimed, started, finished or reviewed',
  '- describes a task, its scope or its next step, or what a worker or watchdog will do',
  '- restates a UI change that was just built (the code now records it)',
  'Test before answering NEW: would a different session, a month from now, act differently because of it?',
  'If not, or if you are unsure, answer NOTHING.',
  '',
  'Read MISSION, CONTEXT and TARGET together as one picture. The memory may come from any part of it;',
  'TARGET is only the newest piece. MISSION is framing: never save the mission itself.',
  'Tool results are evidence for a finding, not findings in themselves.',
  'A finding the assistant already told the user is NOT saved yet. Only the entries under ALREADY SAVED are saved.',
  '',
  'Reply in exactly one of these three forms, with no other text:',
  '',
  'NOTHING',
  '',
  'NEW',
  'TLDR: <the fact itself in one line, with the specific terms someone would search for>',
  'CONTENT: <the fact with what is needed to use it, about 300 characters>',
  '',
  'UPDATE <number from ALREADY SAVED>',
  'TLDR: <the fuller fact in one line>',
  'CONTENT: <the fuller fact, about 300 characters>',
  '',
  'A good TLDR: "RS485 on the EG004 needs 9600 baud". A bad TLDR: "Baud rate finding".',
  'Use UPDATE only when the picture got fuller than a memory in ALREADY SAVED. If it is already covered, answer NOTHING.',
].join('\n');

/** One row of the recording-model picker. */
export interface RecordingModelOption {
  id: string;
  name: string;
  /** `api` = Helm sends the request itself; `cli` = a real CLI, run once headless per pass. */
  kind: 'api' | 'cli';
  available: boolean;
  /** Why an unavailable model cannot be picked; on a real CLI that can, what picking it costs. */
  note?: string;
}

/** What the Settings tab reads back from every get/set. */
export type AutoMemoryState =
  | { success: true; settings: AutoMemorySettings; models: RecordingModelOption[] }
  | { success: false; error: string };

/** Shown next to every real CLI type that can record: the price is the reason to think twice. */
export const CLI_COST_NOTE = 'real CLI: its full prompt on every turn';

/** Shown next to an API tool whose block lacks a base URL or a model. */
export const INCOMPLETE_API_NOTE = 'API settings are incomplete';

/** A silent run never throws: the caller reads the outcome. */
export type SilentRunResult =
  | { status: 'ok'; text: string }
  /** Nothing was asked of any model (no recording model picked). */
  | { status: 'inert'; reason: string }
  | { status: 'failed'; error: string };
