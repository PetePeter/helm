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
}

export const DEFAULT_AUTO_MEMORY_SETTINGS: AutoMemorySettings = {
  recordingModel: '',
  autoSave: true,
  autoRecall: true,
};

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
