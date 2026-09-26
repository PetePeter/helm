import * as path from 'path';
import { randomUUID } from 'crypto';
import logger from '../utils/logger.js';
import { getConfigDir, isPackaged, seedConfigIfNeeded } from '../utils/app-paths.js';
import { fileURLToPath } from 'url';
import {
  isCliTypeOptions,
  normalizeMcpPort,
  normalizeFleetPort,
  normalizeMobileLanPort,
  parseCommandTemplate,
  type CliTypeOptions,
  type EnvVarEntry,
  type HelmActionMap,
  type SpawnConfig,
} from './loader-helpers.js';
import { CliTypeStore, type ResolvedCliType } from './cli-type-store.js';
import { BindingStore } from './binding-store.js';
import { InputConfigStore } from './input-config-store.js';
import { migrateFromProfile } from './profile-migrator.js';
import { migrateCliTypeIds, defaultCliTypeMigrationFiles } from './cli-type-migration.js';
import { normalizeProjectPath, dirDisplayNameFromPath } from '../session/project-identity.js';
import type { ProjectStore } from '../session/project-store.js';
import {
  DEFAULT_FLEET_CONFIG,
  DEFAULT_MCP_CONFIG,
  DEFAULT_MOBILE_LAN_CONFIG,
  DEFAULT_OPERATOR_CONFIG,
  SettingsManager,
} from './settings-manager.js';
import { TelegramConfigManager } from './telegram-config-manager.js';
import { DEFAULT_SUGGESTION_SCORING, type SuggestionScoringWeights } from '../session/hooks/suggestion-scorer.js';
import {
  REMINDER_IDS,
  isReminderDeliveryMode,
  type ReminderDeliveryMode,
  type ReminderId,
} from '../session/reminder-delivery.js';
import { DEFAULT_MAX_AUTO_CONTINUES, type LoopConfig } from '../session/hooks/loop-driver.js';

export { parseCliArgs, resolveEnvWithMode, slugify } from './loader-helpers.js';
export type { CliTypeOptions, EnvVarEntry, HelmActionMap, SpawnConfig } from './loader-helpers.js';
export { AmbiguousCliTypeError } from './cli-type-store.js';
export type { ResolvedCliType } from './cli-type-store.js';

// ============================================================================
// Action & Binding Types
// ============================================================================

export type ActionType = 'keyboard' | 'voice' | 'voice-talk' | 'scroll' | 'context-menu' | 'prompt-tree' | 'new-draft';

interface BaseBinding {
  action: ActionType;
}

interface KeyboardBinding extends BaseBinding {
  action: 'keyboard';
  sequence: string;
}

interface VoiceBinding extends BaseBinding {
  action: 'voice';
  key: string;
  mode: 'tap' | 'hold';
  target?: 'terminal';
}

/** Hold-to-talk to the Helm operator: press records, release sends (docs/voice-operator.md). */
interface VoiceTalkBinding extends BaseBinding {
  action: 'voice-talk';
}

interface ScrollBinding extends BaseBinding {
  action: 'scroll';
  direction: 'up' | 'down';
  lines?: number;  // defaults to 5
}

interface ContextMenuBinding extends BaseBinding {
  action: 'context-menu';
}

export interface SequenceListItem {
  label: string;
  sequence: string;
}

interface PromptTreeBinding extends BaseBinding {
  action: 'prompt-tree';
}

interface NewDraftBinding extends BaseBinding {
  action: 'new-draft';
}

export type Binding = KeyboardBinding | VoiceBinding | VoiceTalkBinding | ScrollBinding | ContextMenuBinding | PromptTreeBinding | NewDraftBinding;

// ============================================================================
// Pattern Rules
// ============================================================================

/**
 * A user-defined regex pattern that fires an automated action when matched
 * against PTY output for a specific CLI type.
 */
export interface PatternRule {
  /** JavaScript regex string (without delimiters). Case-insensitive matching is applied automatically. */
  regex: string;
  /** Action to take when the regex matches. */
  action: 'wait-until' | 'send-text';
  /**
   * wait-until only: 1-based capture group index containing the scheduled time string.
   * If omitted (or group not found), falls back to waitMs.
   */
  timeGroup?: number;
  /**
   * wait-until only: fixed delay in ms to wait before sending onResume.
   * Used when timeGroup is absent or fails to parse.
   */
  waitMs?: number;
  /** wait-until only: sequence sent to PTY after the wait period. */
  onResume?: string;
  /** send-text only: sequence sent immediately when match fires. */
  sequence?: string;
  /** Cooldown in ms before this rule can fire again for the same session. Default: 300000 (5 min). */
  cooldownMs?: number;
}

// ============================================================================
// Shared Config Types
// ============================================================================

/** A bare CLI-type identity. Matching this means the reference is an id, not a label. */
const CLI_TYPE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * System-wide CLI hook integration for a CLI type (G1 transport, G2 deny rules).
 * `configPath` is user-level, `~`-relative, and points into the CLI's OWN
 * config dir — the one directory outside Helm's tree that Helm ever writes.
 */
export interface CliHooksIntegration {
  /** Which CLI family's payload shape and config format to use. */
  provider: 'claude' | 'codex' | 'copilot';
  /** User-level config file the installer writes the Helm-owned block into. */
  configPath: string;
  /** Event names to register, spelled the way this CLI spells them. */
  events: string[];
  /**
   * G2 PreToolUse deny rules (see HookDenyRule in session/hooks/hook-policy).
   * User-editable yaml — the policy validates each rule's shape itself and
   * skips anything malformed, so this stays loosely typed on purpose.
   */
  denyRules?: unknown[];
}

export interface CliTypeConfig {
  /** Stable UUID v4 identity — also the map key in cli-types.yaml. Renaming never changes it.
   *  Optional in the type only so legacy YAML and older literals still parse; every entry that
   *  passes through CliTypeStore is guaranteed to carry one. */
  id?: string;
  /** Free-text human label. Authoritative — `name` is kept in sync as a deprecated alias. */
  displayName?: string;
  /** The pre-UUID slug key this entry was migrated from. Diagnostic only. */
  legacyKey?: string;
  /** @deprecated Alias of displayName, kept so existing readers keep working. */
  name: string;
  /** Extra environment variables injected into the spawned CLI process. */
  env?: EnvVarEntry[];
  initialPrompt?: SequenceListItem[];
  initialPromptDelay?: number;
  /** Send [HELM_MSG] envelope when another Helm session sends text to this recipient. Default: true. When false, plain text only. */
  helmPreambleForInterSession?: boolean;
  /** For large session_send_text MCP handoffs, write the payload to a temp file and paste instructions with the path instead. */
  largeTextAsTempFile?: boolean;
  /**
   * Whether MessNotifier may poke this CLI with an unread-Mess system reminder.
   * Default: true. Set false for CLIs that are not an LLM — prose injected into
   * a plain shell's stdin is not a nudge, it is a stray command.
   */
  messReminders?: boolean;
  /**
   * Let the CLI enable xterm mouse tracking (DECSET 1000-1016). Default: false —
   * mouse modes are swallowed so plain click-drag selects text for copying.
   */
  mouseTracking?: boolean;
  /** Named sequence groups — accessible via gamepad bindings and context menu */
  sequences?: Record<string, SequenceListItem[]>;
  /** Command sent to PTY after spawn to name the session for later resume. Template: {cliSessionName} replaced at runtime. */
  renameCommand?: string;
  /** CLI parameter template for fresh spawn with session UUID. Template: {cliSessionName} replaced at runtime.
   * Example: "claude --session-id {cliSessionName}" or "copilot --resume={cliSessionName}" */
  spawnCommand?: string;
  /** CLI parameter template to resume a specific session. Templates replaced at runtime:
   * {cliSessionName} (Helm's UUID) and {cliThreadId} (the CLI's own id from its hooks; left literal if never captured).
   * Example: "claude --resume={cliSessionName}" or "codex resume {cliThreadId}" */
  resumeCommand?: string;
  /** CLI command to resume most recent session (fallback when resumeCommand is not configured). */
  continueCommand?: string;
  /** Escape sequence sent after text delivery (e.g. '\r', '\n', or '\r\n'). Empty string clears/uses default. */
  submitSuffix?: string;
  /** Command pasted into the PTY by session_clear to reset the CLI's context. Default: '/clear'.
   *  @deprecated Prefer helmActions.clear — clearCommand is kept as a fallback for legacy configs. */
  clearCommand?: string;
  /** Maps the three Helm worker-control actions to this CLI's built-in commands, in sequence syntax.
   *  Blank/absent compact & export = unsupported (their MCP tool returns an error). clear is special:
   *  when blank it falls back to legacy clearCommand, then '/clear', so session_clear always has a default.
   *  Use {Wait N} to hold the MCP call's return (delivery is awaited), {NoSend} to suppress the implied Enter. */
  helmActions?: HelmActionMap;
  /** User-defined regex patterns that trigger automated actions when matched against PTY output. */
  patterns?: PatternRule[];
  /**
   * Which CLI family this tool actually speaks ('claude' | 'codex' | 'copilot').
   * Auto-migrated on load from the name/commands/hooks block; the CLI
   * Integrations pane's Tool mapping dropdown sets it explicitly. `null` is
   * "explicitly unmapped" — the user answered the dropdown with Not mapped,
   * and migration must respect that forever, never re-infer. Drives hook
   * capability (hook-capability.ts) — install/uninstall are provider-keyed
   * and do NOT consult per-type hooks blocks (see session/hooks/hook-providers.ts).
   */
  provider?: 'claude' | 'codex' | 'copilot' | null;
  /** Legacy carrier of provider + denyRules for this type. Install/uninstall no longer read it; denyRules remain user-editable here. */
  hooks?: CliHooksIntegration;
}

export interface ButtonBindings {
  [button: string]: Binding;
}

export interface WorkingDirectory {
  name: string;
  path: string;
}

export interface SidebarPrefs {
  width: number;
  height?: number;
  x?: number;
  y?: number;
}

const DEFAULT_SIDEBAR_PREFS: SidebarPrefs = { width: 1280 };

export interface SnapOutWindowPrefs {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

// ============================================================================
// Sorting Config Types
// ============================================================================

export type SessionSortField = 'state' | 'cliType' | 'directory' | 'name';
export type BindingSortField = 'button' | 'action';
export type SortDirection = 'asc' | 'desc';

export interface AreaSortPrefs {
  field: string;
  direction: SortDirection;
}

export interface SortingConfig {
  sessions: AreaSortPrefs;
  bindings: AreaSortPrefs;
}

export type PlanFilterTriState = 'either' | 'yes' | 'no';

export interface PlanFilterConfig {
  types: { bug: PlanFilterTriState; feature: PlanFilterTriState; research: PlanFilterTriState; untyped: PlanFilterTriState };
  statuses: { planning: PlanFilterTriState; ready: PlanFilterTriState; coding: PlanFilterTriState; review: PlanFilterTriState; blocked: PlanFilterTriState; done: PlanFilterTriState };
  hasAttachment: { yes: PlanFilterTriState; no: PlanFilterTriState };
  auto: PlanFilterTriState;
}

const DEFAULT_SORTING: SortingConfig = {
  sessions: { field: 'state', direction: 'asc' },
  bindings: { field: 'button', direction: 'asc' },
};

const DEFAULT_PLAN_FILTERS: PlanFilterConfig = {
  types: { bug: 'either', feature: 'either', research: 'either', untyped: 'either' },
  statuses: { planning: 'either', ready: 'either', coding: 'either', review: 'either', blocked: 'either', done: 'either' },
  hasAttachment: { yes: 'either', no: 'either' },
  auto: 'either',
};

export interface TelegramConfig {
  enabled: boolean;
  autoStart: boolean;
  botToken: string;
  instanceName: string;
  chatId: number | null;
  allowedUserIds: number[];
  safeModeDefault: boolean;
  notifyOnComplete: boolean;
  notifyOnIdle: boolean;
  notifyOnError: boolean;
  notifyOnCrash: boolean;
  openWhisprPath: string;
  openWhisprModelPath: string;
  piperPath: string;
  piperVoicePath: string;
  ffmpegPath: string;
}

export interface McpConfig {
  enabled: boolean;
  port: number;
  authToken: string;
}

/**
 * Cross-machine fleet transport config (P-0646). OFF by default — nothing
 * binds the fleet listener unless `enabled` is explicitly true. This is a
 * SEPARATE listener from the 127.0.0.1 localhost MCP server.
 */
export interface FleetConfig {
  enabled: boolean;
  host: string;
  port: number;
}

/**
 * Phone LAN transport config (P-0752). OFF by default — nothing binds unless
 * `enabled` is explicitly true AND a phone is paired.
 *
 * There is deliberately NO host field, and no phone address: Helm LISTENS and
 * the phone dials, so the only address that matters lives on the phone. The
 * bind is a wildcard, exactly as for the fleet listener.
 */
export interface MobileLanConfig {
  enabled: boolean;
  port: number;
}

/** The router-only "Helm" operator session (docs/voice-operator.md). */
export interface OperatorConfig {
  enabled: boolean;
  /** Id of one of the user's CLI types; empty = not chosen, nothing spawns. */
  cliType: string;
  /** Working dir the operator spawns in; empty = the CLI's default. */
  workingDir: string;
  /** Idle self-compaction cadence in minutes; 0 = off. */
  compactEveryMinutes: number;
  /** User rules appended to the operator guide, one per line; built-in rules still apply. */
  rules: string;
}

function normalizeCompactMinutes(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : DEFAULT_OPERATOR_CONFIG.compactEveryMinutes;
}

export interface EditorPrefs {
  draftEditorHeight?: number;
  contextEditorHeight?: number;
  planEditorHeight?: number;
  editorPopupWidth?: number;
  editorPopupHeight?: number;
  sequenceModalWidth?: number;
  sequenceModalHeight?: number;
  sequenceModalBounds?: { left: number; top: number; right: number; bottom: number };
}

export type UpdateCheckMode = 'auto' | 'manual';

export interface SettingsConfig {
  hapticFeedback: boolean;
  notifications: boolean;
  escProtectionEnabled: boolean;
  /** Self-update: 'auto' checks GitHub at launch, 'manual' only on "Check now". */
  updateCheck?: UpdateCheckMode;
  sidebar?: SidebarPrefs;
  snapOutWindows?: Record<string, SnapOutWindowPrefs>;
  sorting?: SortingConfig;
  planFilters?: PlanFilterConfig;
  sessionGroups?: SessionGroupPrefs;
  editorHistory?: string[];
  editorPrefs?: EditorPrefs;
  /**
   * The persisted dock workspace tree. Deliberately opaque here: the schema is
   * owned by the renderer dock model, and the only trustworthy validator lives
   * next to it. Main stores and returns it verbatim so a layout written by a
   * newer build cannot crash an older one on load — the renderer rejects it and
   * falls back to the default layout instead.
   */
  workspaceLayout?: unknown;
  /** Same contract, for the shared snap-out pop-out profile. */
  popoutWorkspaceLayout?: unknown;
  telegram?: TelegramConfig;
  mcp?: McpConfig;
  fleet?: FleetConfig;
  /**
   * G5 suggester signal weights (docs/cli-hooks.md, G5). Absent means the
   * shipped defaults; every field is optional so a user can tune one signal
   * without declaring the rest. Weights are configuration, not buried magic.
   */
  suggestionScoring?: Partial<SuggestionScoringWeights>;
  /**
   * G9 per-reminder delivery modes (docs/cli-hooks.md, G9): hook / pty / off
   * for each standing reminder. Absent field = that reminder's shipped
   * default, which reproduces today's behaviour exactly.
   */
  reminderDelivery?: Partial<Record<ReminderId, ReminderDeliveryMode>>;
  /** Phone LAN transport (P-0752). Absent means the defaults, i.e. off. */
  mobileLan?: MobileLanConfig;
  /** Voice operator singleton. Absent means the defaults, i.e. off. */
  operator?: OperatorConfig;
  /**
   * G8 loop driving (docs/cli-hooks.md, G8): the global kill switch and the
   * consecutive auto-continue cap. Absent means allowed at the shipped cap —
   * the only opt-in is autoImplement on the plan (G10), so this switch is
   * opt-OUT, the emergency brake.
   */
  hooks?: {
    loopDriving?: { enabled?: boolean; maxAutoContinues?: number };
  };
  /** Pre-rename key, read-only migration input for `fleet`. Never written. */
  federation?: FleetConfig;
}

/**
 * Which window profile a stored dock layout belongs to. Mirrors the renderer's
 * `DockProfileId`; duplicated as a plain union rather than imported so main
 * keeps no dependency on renderer code.
 */
export type WorkspaceLayoutProfile = 'main' | 'popout';

const WORKSPACE_LAYOUT_FIELDS = {
  main: 'workspaceLayout',
  popout: 'popoutWorkspaceLayout',
} as const;

function workspaceLayoutField(profile: WorkspaceLayoutProfile): 'workspaceLayout' | 'popoutWorkspaceLayout' {
  return WORKSPACE_LAYOUT_FIELDS[profile] ?? WORKSPACE_LAYOUT_FIELDS.main;
}

export interface SessionGroupPrefs {
  order: string[];
  collapsed: string[];
  /** Bookmarked directory paths — persist as empty groups even with no sessions. */
  bookmarked?: string[];
  /** Session IDs hidden from overview. */
  overviewHidden?: string[];
  /** Session List PTY preview density. Absent = 'on'. */
  sessionPreviewMode?: 'on' | 'off' | 'selected-only';
}

export interface ChipbarAction {
  label: string;
  sequence: string;
}

/**
 * ProfileConfig is kept for backward type compatibility with any consumers that
 * may import it. The profile system itself has been replaced by dedicated stores.
 */
export interface ProfileConfig {
  version?: number;
  name: string;
  tools: { [key: string]: CliTypeConfig };
  workingDirectories: WorkingDirectory[];
  bindings: { [key: string]: ButtonBindings };
  sticks?: StickConfigs;
  dpad?: DpadConfig;
  activity?: ActivityConfig;
  chipActions?: ChipbarAction[];
}

// ============================================================================
// Stick Config Types
// ============================================================================

export interface DpadConfig {
  initialDelay: number;  // ms before first repeat (default 400)
  repeatRate: number;    // ms between repeats (default 120)
}

// ============================================================================
// Activity Config Types
// ============================================================================

export interface ActivityConfig {
  timeoutMs: number;  // ms of no output before considering session inactive (default 5000)
}

type StickMode = 'cursor' | 'scroll' | 'disabled';

export interface StickConfig {
  mode: StickMode;
  deadzone: number;    // 0.0–1.0 normalized
  repeatRate: number;  // ms between repeat events
}

export interface StickConfigs {
  left?: StickConfig;
  right?: StickConfig;
}

/** Virtual button names for joystick directions — bindable like physical buttons */
export const STICK_VIRTUAL_BUTTONS = [
  'LeftStickUp', 'LeftStickDown', 'LeftStickLeft', 'LeftStickRight',
  'RightStickUp', 'RightStickDown', 'RightStickLeft', 'RightStickRight',
] as const;

export type StickVirtualButton = typeof STICK_VIRTUAL_BUTTONS[number];

export type StickDirection = 'up' | 'down' | 'left' | 'right';

/** Build a virtual button name from stick + direction */
export function stickVirtualButtonName(stick: 'left' | 'right', direction: StickDirection): StickVirtualButton {
  const prefix = stick === 'left' ? 'LeftStick' : 'RightStick';
  const suffix = direction.charAt(0).toUpperCase() + direction.slice(1);
  return `${prefix}${suffix}` as StickVirtualButton;
}

// ============================================================================
// ConfigLoader
// ============================================================================

const __loader_dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_DIR = getConfigDir(__loader_dirname);

// Seed user-data config from bundled defaults on first launch
// Source differs (asar vs source tree) but target is always %APPDATA%/Helm/config
const sourceConfigDir = isPackaged(__loader_dirname)
  ? path.join(__loader_dirname, '..', 'config')
  : path.join(process.cwd(), 'src', 'config');
seedConfigIfNeeded(sourceConfigDir, DEFAULT_CONFIG_DIR);

export class ConfigLoader {
  private configDir: string;
  private cliTypeStore: CliTypeStore;
  private bindingStore: BindingStore;
  private inputConfigStore: InputConfigStore;
  private settingsManager: SettingsManager;
  private telegramConfigManager: TelegramConfigManager;
  private settings: SettingsConfig | null = null;
  private projectStore?: ProjectStore;

  constructor(configDir: string = DEFAULT_CONFIG_DIR) {
    this.configDir = configDir;
    this.cliTypeStore = new CliTypeStore(configDir);
    this.bindingStore = new BindingStore(configDir);
    this.inputConfigStore = new InputConfigStore(configDir);
    this.settingsManager = new SettingsManager(configDir);
    this.telegramConfigManager = new TelegramConfigManager(
      () => this.settings,
      () => this.saveSettings(),
    );
  }

  // ---------- Loading --------------------------------------------------

  load(): void {
    this.loadSettings();
    this.cliTypeStore.load();
    this.bindingStore.load();
    this.inputConfigStore.load();
    migrateFromProfile(this.configDir, this.cliTypeStore, this.bindingStore, this.inputConfigStore);
    // Re-key slug-based CLI types to UUIDs. Runs after the profile migration so
    // types it just imported are covered too; rewrites files directly, hence the
    // reload of the two stores whose backing files it touched.
    if (migrateCliTypeIds(defaultCliTypeMigrationFiles(this.configDir))) {
      this.cliTypeStore.load();
      this.bindingStore.load();
    }
  }

  private loadSettings(): void {
    this.settings = this.settingsManager.load();
  }

  /**
   * No-op: profile system removed. Configuration is now managed by dedicated stores
   * (CliTypeStore, BindingStore, InputConfigStore). Kept for API compatibility.
   */
  reloadActiveProfileIfChanged(): void {
    // No-op: profile system removed
  }

  // ---------- Existing read methods (backward compatible) ---------------

  private ensureLoaded(): void {
    if (!this.settings) {
      throw new Error('Configuration not loaded. Call load() first.');
    }
  }

  /**
   * Resolve a human- or agent-supplied CLI type reference (uuid, legacy slug, or
   * display name) to its entry plus canonical uuid key. Null means "no such CLI
   * type" — there is deliberately no fallback. See CliTypeStore.resolve.
   */
  resolveCliType(ref: string): ResolvedCliType | null {
    this.ensureLoaded();
    return this.cliTypeStore.resolve(ref);
  }

  /** Canonical map key for a CLI type reference; unknown refs pass through. */
  private resolveCliTypeKey(cliType: string): string {
    return this.cliTypeStore.resolveKey(cliType);
  }

  getBindings(cliType: string): ButtonBindings | null {
    this.ensureLoaded();
    return this.bindingStore.get(this.resolveCliTypeKey(cliType));
  }

  getSpawnConfig(cliType: string): SpawnConfig | null {
    this.ensureLoaded();
    const config = this.cliTypeStore.get(cliType);
    if (!config) return null;
    return this.buildSpawnConfig(config);
  }

  getCliTypeEntry(cliType: string): CliTypeConfig | null {
    this.ensureLoaded();
    return this.cliTypeStore.get(cliType) ?? null;
  }

  /** Set/clear which CLI family a tool speaks (Tool mapping dropdown). */
  setCliTypeProvider(key: string, provider: 'claude' | 'codex' | 'copilot' | null): void {
    this.ensureLoaded();
    this.cliTypeStore.setCliTypeProvider(key, provider);
  }

  getCliTypeName(cliType: string): string | null {
    this.ensureLoaded();
    const entry = this.cliTypeStore.get(cliType);
    return entry ? (entry.displayName ?? entry.name ?? null) : null;
  }

  /**
   * Display label for any CLI type reference, for text a human will read.
   * Never throws and never returns null: an unresolvable reference falls back to
   * itself, except a bare UUID, which is an identity no user should ever see.
   */
  getCliTypeLabel(cliType: string): string {
    const ref = typeof cliType === 'string' ? cliType.trim() : '';
    try {
      const name = this.getCliTypeName(ref);
      if (name && name.trim()) return name.trim();
    } catch { /* ambiguous label — fall through to the raw reference */ }
    if (!ref || CLI_TYPE_UUID_RE.test(ref)) return 'Unknown CLI';
    return ref;
  }

  getCliTypes(): string[] {
    this.ensureLoaded();
    return this.cliTypeStore.list();
  }

  /**
   * G2 deny rules for a hook provider. A HookEvent names the CLI family, not
   * the config key, so this scans for the first CLI type whose hooks block
   * carries that provider. No match or no rules configured = deny nothing
   * (fail open), so an empty return is a valid answer, not an error.
   */
  getHookDenyRules(provider: 'claude' | 'codex' | 'copilot'): unknown[] {
    this.ensureLoaded();
    for (const config of Object.values(this.cliTypeStore.getAll())) {
      if (config.hooks?.provider === provider) return config.hooks.denyRules ?? [];
    }
    return [];
  }

  /** Get all named sequence groups for a CLI type */
  getSequences(cliType: string): Record<string, SequenceListItem[]> {
    this.ensureLoaded();
    return this.cliTypeStore.get(cliType)?.sequences ?? {};
  }

  /** Get a specific named sequence group for a CLI type */
  getSequenceGroup(cliType: string, groupId: string): SequenceListItem[] | null {
    this.ensureLoaded();
    return this.cliTypeStore.get(cliType)?.sequences?.[groupId] ?? null;
  }

  /** Create or update a named sequence group for a CLI type */
  setSequenceGroup(cliType: string, groupId: string, items: SequenceListItem[]): void {
    this.ensureLoaded();
    const entry = this.cliTypeStore.get(cliType);
    if (!entry) throw new Error(`Unknown CLI type: ${cliType}`);
    if (!entry.sequences) entry.sequences = {};
    entry.sequences[groupId] = items;
    this.cliTypeStore.set(cliType, entry);
  }

  /** Remove a named sequence group for a CLI type */
  removeSequenceGroup(cliType: string, groupId: string): void {
    this.ensureLoaded();
    const entry = this.cliTypeStore.get(cliType);
    if (entry?.sequences) {
      delete entry.sequences[groupId];
      if (Object.keys(entry.sequences).length === 0) delete entry.sequences;
      this.cliTypeStore.set(cliType, entry);
    }
  }

  getStickConfig(stick: 'left' | 'right'): StickConfig {
    this.ensureLoaded();
    return this.inputConfigStore.getStickConfig(stick);
  }

  getDpadConfig(): DpadConfig {
    this.ensureLoaded();
    return this.inputConfigStore.getDpadConfig();
  }

  getActivityTimeout(): number {
    this.ensureLoaded();
    return this.inputConfigStore.getActivityTimeout();
  }

  setActivityTimeout(timeoutMs: number): void {
    this.ensureLoaded();
    this.inputConfigStore.setActivityTimeout(timeoutMs);
  }

  getChipbarActions(): { actions: ChipbarAction[]; inboxDir: string } {
    this.ensureLoaded();
    return {
      actions: this.inputConfigStore.getChipbarActions(),
      inboxDir: path.join(this.configDir, 'plans', 'incoming'),
    };
  }

  setChipbarActions(actions: ChipbarAction[]): void {
    this.ensureLoaded();
    this.inputConfigStore.setChipbarActions(actions);
  }

  getSkillsPath(): string {
    return path.join(this.configDir, 'skills.yaml');
  }

  getSkillAnalyticsPath(): string {
    return path.join(this.configDir, 'skill-analytics.json');
  }

  /**
   * Working directories are derived from the project store — projects are the
   * single source of truth. Each project's canonical and alternate paths become
   * a working directory named after the project (deduplicated by normalized
   * path). There is no separate persisted working-dir list, so a folder removed
   * from a project disappears here immediately and can never linger as an
   * unattributed ("Other") entry.
   */
  getWorkingDirectories(): WorkingDirectory[] {
    this.ensureLoaded();
    if (!this.projectStore) return [];
    const seen = new Set<string>();
    const dirs: WorkingDirectory[] = [];
    for (const project of this.projectStore.list()) {
      for (const dirPath of [project.canonicalPath, ...(project.alternatePaths ?? [])]) {
        const key = normalizeProjectPath(dirPath);
        if (seen.has(key)) continue;
        seen.add(key);
        dirs.push({ name: project.name, path: dirPath });
      }
    }
    return dirs;
  }

  setProjectStore(store: ProjectStore): void {
    this.projectStore = store;
  }

  // ---------- Binding edit (backward compatible) -----------------------

  setBinding(button: string, cliType: string, binding: Binding): void {
    this.ensureLoaded();
    cliType = this.resolveCliTypeKey(cliType);
    // Auto-create binding entry if CLI type exists in tools but not yet in bindings
    if (!this.bindingStore.get(cliType)) {
      if (this.cliTypeStore.get(cliType)) {
        this.bindingStore.ensureCliType(cliType);
      } else {
        throw new Error(`Unknown CLI type: ${cliType}`);
      }
    }
    this.bindingStore.setButton(button, cliType, binding);
  }

  removeBinding(button: string, cliType: string): void {
    this.ensureLoaded();
    this.bindingStore.removeButton(button, this.resolveCliTypeKey(cliType));
  }

  copyCliBindings(sourceCli: string, targetCli: string): number {
    this.ensureLoaded();
    sourceCli = this.resolveCliTypeKey(sourceCli);
    targetCli = this.resolveCliTypeKey(targetCli);
    // Validate source has bindings
    if (!this.bindingStore.get(sourceCli)) {
      throw new Error(`No bindings found for source: ${sourceCli}`);
    }
    // Validate target CLI type exists
    if (!this.cliTypeStore.get(targetCli)) {
      throw new Error(`Unknown target CLI type: ${targetCli}`);
    }
    const count = this.bindingStore.copy(sourceCli, targetCli);

    // Copy sequences from source CLI type to target
    const sourceEntry = this.cliTypeStore.get(sourceCli);
    const sourceSequences = sourceEntry?.sequences;
    if (sourceSequences && Object.keys(sourceSequences).length > 0) {
      const targetEntry = this.cliTypeStore.get(targetCli);
      if (!targetEntry) throw new Error(`Unknown target CLI type: ${targetCli}`);
      targetEntry.sequences = structuredClone(sourceSequences);
      this.cliTypeStore.set(targetCli, targetEntry);
    }

    return count;
  }

  getHapticFeedback(): boolean {
    this.ensureLoaded();
    return this.settings!.hapticFeedback;
  }

  setHapticFeedback(enabled: boolean): void {
    this.ensureLoaded();
    this.settings!.hapticFeedback = enabled;
    this.saveSettings();
  }

  getNotifications(): boolean {
    this.ensureLoaded();
    return this.settings!.notifications;
  }

  setNotifications(enabled: boolean): void {
    this.ensureLoaded();
    this.settings!.notifications = enabled;
    this.saveSettings();
  }

  getEscProtectionEnabled(): boolean {
    this.ensureLoaded();
    return this.settings!.escProtectionEnabled ?? true;
  }

  setEscProtectionEnabled(enabled: boolean): void {
    this.ensureLoaded();
    this.settings!.escProtectionEnabled = enabled;
    this.saveSettings();
  }

  getUpdateCheckMode(): UpdateCheckMode {
    this.ensureLoaded();
    return this.settings!.updateCheck === 'manual' ? 'manual' : 'auto';
  }

  setUpdateCheckMode(mode: UpdateCheckMode): void {
    this.ensureLoaded();
    this.settings!.updateCheck = mode;
    this.saveSettings();
  }

  getSidebarPrefs(): SidebarPrefs {
    this.ensureLoaded();
    const saved = this.settings!.sidebar;
    if (!saved) return { ...DEFAULT_SIDEBAR_PREFS };
    return {
      width: saved.width ?? DEFAULT_SIDEBAR_PREFS.width,
      height: saved.height,
      x: saved.x,
      y: saved.y,
    };
  }

  setSidebarPrefs(prefs: Partial<SidebarPrefs>): void {
    this.ensureLoaded();
    const current = this.getSidebarPrefs();
    this.settings!.sidebar = { ...current, ...prefs };
    this.saveSettings();
  }

  /**
   * Return the renderer-owned dock tree for a window profile, if persisted.
   *
   * The main profile keeps the original `workspaceLayout` key so existing
   * settings load untouched; other profiles get their own field.
   */
  getWorkspaceLayout(profile: WorkspaceLayoutProfile = 'main'): unknown {
    this.ensureLoaded();
    return this.settings![workspaceLayoutField(profile)];
  }

  /** Persist the renderer-owned dock tree without interpreting its schema here. */
  setWorkspaceLayout(layout: unknown, profile: WorkspaceLayoutProfile = 'main'): void {
    this.ensureLoaded();
    this.settings![workspaceLayoutField(profile)] = layout;
    this.saveSettings();
  }

  getSnapOutWindowPrefs(sessionId: string): SnapOutWindowPrefs | null {
    this.ensureLoaded();
    const prefs = this.settings!.snapOutWindows?.[sessionId];
    if (!prefs) return null;
    return {
      width: prefs.width,
      height: prefs.height,
      x: prefs.x,
      y: prefs.y,
    };
  }

  setSnapOutWindowPrefs(sessionId: string, prefs: SnapOutWindowPrefs): void {
    this.ensureLoaded();
    this.settings!.snapOutWindows = {
      ...(this.settings!.snapOutWindows ?? {}),
      [sessionId]: prefs,
    };
    this.saveSettings();
  }

  clearSnapOutWindowPrefs(sessionId: string): void {
    this.ensureLoaded();
    if (!this.settings!.snapOutWindows?.[sessionId]) return;
    const next = { ...this.settings!.snapOutWindows };
    delete next[sessionId];
    this.settings!.snapOutWindows = next;
    this.saveSettings();
  }

  getSortPrefs(area: 'sessions' | 'bindings'): AreaSortPrefs {
    this.ensureLoaded();
    const sorting = this.settings!.sorting;
    if (sorting && sorting[area]) {
      return { ...DEFAULT_SORTING[area], ...sorting[area] };
    }
    return { ...DEFAULT_SORTING[area] };
  }

  setSortPrefs(area: 'sessions' | 'bindings', prefs: Partial<AreaSortPrefs>): void {
    this.ensureLoaded();
    if (!this.settings!.sorting) {
      this.settings!.sorting = { ...DEFAULT_SORTING };
    }
    this.settings!.sorting[area] = { ...this.settings!.sorting[area], ...prefs };
    this.saveSettings();
  }

  getPlanFilters(): PlanFilterConfig {
    this.ensureLoaded();
    const saved = this.settings!.planFilters;
    return {
      types: {
        ...DEFAULT_PLAN_FILTERS.types,
        ...(saved?.types ?? {}),
      },
      statuses: {
        ...DEFAULT_PLAN_FILTERS.statuses,
        ...(saved?.statuses ?? {}),
      },
      hasAttachment: {
        ...DEFAULT_PLAN_FILTERS.hasAttachment,
        ...(saved?.hasAttachment ?? {}),
      },
      auto: saved?.auto ?? DEFAULT_PLAN_FILTERS.auto,
    };
  }

  setPlanFilters(filters: Partial<PlanFilterConfig>): void {
    this.ensureLoaded();
    const current = this.getPlanFilters();
    this.settings!.planFilters = {
      types: {
        ...current.types,
        ...(filters.types ?? {}),
      },
      statuses: {
        ...current.statuses,
        ...(filters.statuses ?? {}),
      },
      hasAttachment: {
        ...current.hasAttachment,
        ...(filters.hasAttachment ?? {}),
      },
      auto: filters.auto ?? current.auto,
    };
    this.saveSettings();
  }

  getSessionGroupPrefs(): SessionGroupPrefs {
    this.ensureLoaded();
    return this.settings!.sessionGroups ?? { order: [], collapsed: [] };
  }

  setSessionGroupPrefs(prefs: SessionGroupPrefs): void {
    this.ensureLoaded();
    this.settings!.sessionGroups = prefs;
    this.saveSettings();
  }

  getEditorHistory(): string[] {
    this.ensureLoaded();
    return Array.isArray(this.settings!.editorHistory)
      ? this.settings!.editorHistory.filter((entry): entry is string => typeof entry === 'string')
      : [];
  }

  setEditorHistory(entries: string[]): void {
    this.ensureLoaded();
    this.settings!.editorHistory = entries;
    this.saveSettings();
  }

  getEditorPrefs(): EditorPrefs {
    this.ensureLoaded();
    return this.settings!.editorPrefs ?? {};
  }

  setEditorPrefs(prefs: Partial<EditorPrefs>): void {
    this.ensureLoaded();
    this.settings!.editorPrefs = { ...(this.settings!.editorPrefs ?? {}), ...prefs };
    this.saveSettings();
  }

  /** Add a directory to the bookmarked list (no-op if already present). */
  addBookmarkedDir(dirPath: string): void {
    this.ensureLoaded();
    const prefs = this.settings!.sessionGroups ?? { order: [], collapsed: [] };
    const bookmarked = prefs.bookmarked ?? [];
    if (!bookmarked.includes(dirPath)) {
      prefs.bookmarked = [...bookmarked, dirPath];
      this.settings!.sessionGroups = prefs;
      this.saveSettings();
    }
  }

  /** Remove a directory from the bookmarked list. */
  removeBookmarkedDir(dirPath: string): void {
    this.ensureLoaded();
    const prefs = this.settings!.sessionGroups ?? { order: [], collapsed: [] };
    const bookmarked = prefs.bookmarked ?? [];
    if (bookmarked.includes(dirPath)) {
      prefs.bookmarked = bookmarked.filter(d => d !== dirPath);
      this.settings!.sessionGroups = prefs;
      this.saveSettings();
    }
  }

  /** Get the current Telegram configuration. */
  getTelegramConfig(): TelegramConfig {
    return this.telegramConfigManager.get();
  }

  /** Update the Telegram configuration (partial merge). */
  setTelegramConfig(updates: Partial<TelegramConfig>): void {
    this.telegramConfigManager.set(updates);
  }

  /** Get the current localhost MCP configuration. */
  getMcpConfig(): McpConfig {
    return {
      ...DEFAULT_MCP_CONFIG,
      ...(this.settings?.mcp ?? {}),
      enabled: this.settings?.mcp?.enabled === true,
      port: normalizeMcpPort(this.settings?.mcp?.port),
      authToken: typeof this.settings?.mcp?.authToken === 'string' ? this.settings.mcp.authToken : '',
    };
  }

  /**
   * G5 suggester signal weights: shipped defaults, overridden field-by-field
   * from settings.yaml. A malformed section degrades to the defaults — bad
   * tuning must never break scoring, only make it duller.
   */
  getSuggestionScoring(): SuggestionScoringWeights {
    const raw = this.settings?.suggestionScoring;
    const overrides = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return { ...DEFAULT_SUGGESTION_SCORING, ...overrides };
  }

  /**
   * G9 reminder delivery: only VALID overrides survive — a malformed value is
   * dropped, never an error, so a hand-edited settings.yaml can only make a
   * reminder revert to its default, never misroute it.
   */
  getReminderDelivery(): Partial<Record<ReminderId, ReminderDeliveryMode>> {
    const raw = this.settings?.reminderDelivery;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const result: Partial<Record<ReminderId, ReminderDeliveryMode>> = {};
    for (const id of REMINDER_IDS) {
      const value = (raw as Record<string, unknown>)[id];
      if (isReminderDeliveryMode(value)) result[id] = value;
    }
    return result;
  }

  /** Merge (and validate) per-reminder delivery modes into settings.yaml. */
  setReminderDelivery(updates: Partial<Record<ReminderId, ReminderDeliveryMode>>): void {
    this.ensureLoaded();
    const merged = { ...this.getReminderDelivery() };
    for (const id of REMINDER_IDS) {
      const value = updates[id];
      if (isReminderDeliveryMode(value)) merged[id] = value;
    }
    this.settings!.reminderDelivery = merged;
    this.saveSettings();
  }

  /**
   * G8 loop driving (docs/cli-hooks.md, G8): the global kill switch and the
   * consecutive auto-continue cap. Malformed values degrade to the shipped
   * defaults — a junk cap can never silently uncap the loop. `enabled`
   * defaults true: the only opt-in is autoImplement on the plan (G10), so
   * this switch is opt-OUT, matching how the rest of the hard stops read.
   */
  getLoopDrivingConfig(): LoopConfig {
    const raw = this.settings?.hooks?.loopDriving;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { enabled: true, maxAutoContinues: DEFAULT_MAX_AUTO_CONTINUES };
    }
    const section = raw as Record<string, unknown>;
    const maxRaw = section.maxAutoContinues;
    const maxAutoContinues =
      typeof maxRaw === 'number' && Number.isInteger(maxRaw) && maxRaw > 0
        ? maxRaw
        : DEFAULT_MAX_AUTO_CONTINUES;
    return {
      enabled: section.enabled !== false,
      maxAutoContinues,
    };
  }

  /** Update the localhost MCP configuration (partial merge). */
  setMcpConfig(updates: Partial<McpConfig>): void {
    if (!this.settings) return;
    const next = {
      ...this.getMcpConfig(),
      ...updates,
    };
    this.settings.mcp = {
      enabled: next.enabled === true,
      port: normalizeMcpPort(next.port),
      authToken: typeof next.authToken === 'string' ? next.authToken : '',
    };
    this.saveSettings();
  }

  /** Get the cross-machine fleet transport config (OFF by default). */
  getFleetConfig(): FleetConfig {
    // `federation` is the pre-rename key. Read it as a fallback so upgrading does
    // not silently disable a working setup; the next setFleetConfig() writes the
    // new key and the old one simply stops being consulted.
    const f = this.settings?.fleet ?? this.settings?.federation;
    return {
      ...DEFAULT_FLEET_CONFIG,
      ...(f ?? {}),
      enabled: f?.enabled === true,
      host: typeof f?.host === 'string' && f.host.length > 0 ? f.host : DEFAULT_FLEET_CONFIG.host,
      port: normalizeFleetPort(f?.port),
    };
  }

  /** Update the fleet transport config (partial merge). */
  setFleetConfig(updates: Partial<FleetConfig>): void {
    if (!this.settings) return;
    const next = { ...this.getFleetConfig(), ...updates };
    this.settings.fleet = {
      enabled: next.enabled === true,
      host: typeof next.host === 'string' && next.host.length > 0 ? next.host : DEFAULT_FLEET_CONFIG.host,
      port: normalizeFleetPort(next.port),
    };
    this.saveSettings();
  }

  /** Get the phone LAN transport config (OFF by default). */
  getMobileLanConfig(): MobileLanConfig {
    const m = this.settings?.mobileLan;
    return {
      ...DEFAULT_MOBILE_LAN_CONFIG,
      ...(m ?? {}),
      enabled: m?.enabled === true,
      port: normalizeMobileLanPort(m?.port),
    };
  }

  /** Update the phone LAN transport config (partial merge). */
  setMobileLanConfig(updates: Partial<MobileLanConfig>): void {
    if (!this.settings) return;
    const next = { ...this.getMobileLanConfig(), ...updates };
    this.settings.mobileLan = {
      enabled: next.enabled === true,
      port: normalizeMobileLanPort(next.port),
    };
    this.saveSettings();
  }

  /** Get the voice operator config (OFF by default). */
  getOperatorConfig(): OperatorConfig {
    const o = this.settings?.operator;
    return {
      enabled: o?.enabled === true,
      cliType: typeof o?.cliType === 'string' ? o.cliType : DEFAULT_OPERATOR_CONFIG.cliType,
      workingDir: typeof o?.workingDir === 'string' ? o.workingDir : DEFAULT_OPERATOR_CONFIG.workingDir,
      compactEveryMinutes: normalizeCompactMinutes(o?.compactEveryMinutes),
      rules: typeof o?.rules === 'string' ? o.rules : DEFAULT_OPERATOR_CONFIG.rules,
    };
  }

  /** Update the voice operator config (partial merge). */
  setOperatorConfig(updates: Partial<OperatorConfig>): void {
    if (!this.settings) return;
    const next = { ...this.getOperatorConfig(), ...updates };
    this.settings.operator = {
      enabled: next.enabled === true,
      cliType: typeof next.cliType === 'string' ? next.cliType.trim() : '',
      workingDir: typeof next.workingDir === 'string' ? next.workingDir.trim() : '',
      compactEveryMinutes: normalizeCompactMinutes(next.compactEveryMinutes),
      rules: typeof next.rules === 'string' ? next.rules.trim() : '',
    };
    this.saveSettings();
  }

  // ---------- Working Directory resolution -----------------------------

  /**
   * Resolve dirPath to a working-directory descriptor. Working dirs are derived
   * from projects, so this returns a transient (non-persisted) entry — callers
   * that must validate project membership do so via the working-dir gate. There
   * is intentionally no persistence side effect: a folder's presence here is
   * governed solely by whether it belongs to a project.
   */
  ensureWorkingDirectory(dirPath: string, name?: string): WorkingDirectory {
    this.ensureLoaded();
    return {
      name: name?.trim() || dirDisplayNameFromPath(dirPath),
      path: dirPath,
    };
  }

  // ---------- Tools CRUD -----------------------------------------------

  addCliType(
    key: string, name: string,
    legacyCommandOrInitialPrompt?: string | SequenceListItem[],
    initialPromptOrDelay?: SequenceListItem[] | number,
    initialPromptDelayOrOptions?: number | CliTypeOptions,
    maybeOptions?: CliTypeOptions,
  ): string {
    this.ensureLoaded();
    // `key` is now only a caller-supplied slug — identity is a freshly minted
    // UUID so a later rename never has to re-key anything. The slug is kept as
    // `legacyKey` so callers that still address CLI types by slug resolve.
    if (this.cliTypeStore.get(key)) {
      throw new Error(`CLI type already exists: ${key}`);
    }
    const id = randomUUID();
    const legacyCommand = typeof legacyCommandOrInitialPrompt === 'string' ? legacyCommandOrInitialPrompt.trim() : '';
    const initialPrompt = Array.isArray(legacyCommandOrInitialPrompt)
      ? legacyCommandOrInitialPrompt
      : (Array.isArray(initialPromptOrDelay) ? initialPromptOrDelay : []);
    const initialPromptDelay = typeof initialPromptDelayOrOptions === 'number'
      ? initialPromptDelayOrOptions
      : (typeof initialPromptOrDelay === 'number' ? initialPromptOrDelay : 0);
    const options = isCliTypeOptions(initialPromptDelayOrOptions)
      ? initialPromptDelayOrOptions
      : maybeOptions;
    // A brand-new type has no pre-UUID history, so it gets no legacyKey — the
    // slug is only meaningful when it is the key an older config addressed.
    const tool: CliTypeConfig = { id, displayName: name, name, initialPrompt, initialPromptDelay };
    if (key && key !== name) tool.legacyKey = key;
    const spawnCommand = options?.spawnCommand?.trim() || legacyCommand;
    if (spawnCommand) tool.spawnCommand = spawnCommand;
    if (options?.env !== undefined && options.env.length > 0) tool.env = options.env;
    if (options?.renameCommand) tool.renameCommand = options.renameCommand;
    if (options?.spawnCommand) tool.spawnCommand = options.spawnCommand;
    if (options?.resumeCommand) tool.resumeCommand = options.resumeCommand;
    if (options?.continueCommand) tool.continueCommand = options.continueCommand;
    if (options?.helmPreambleForInterSession !== undefined) tool.helmPreambleForInterSession = options.helmPreambleForInterSession;
    if (options?.largeTextAsTempFile === true) tool.largeTextAsTempFile = true;
    if (options?.messReminders === false) tool.messReminders = false;
    if (options?.mouseTracking === true) tool.mouseTracking = true;
    const helmActions = this.cleanHelmActions(options?.helmActions);
    if (helmActions) tool.helmActions = helmActions;
    this.cliTypeStore.add(id, tool);
    return id;
  }

  /** Drop blank action mappings; return null when nothing remains (so callers can omit the field). */
  private cleanHelmActions(map?: HelmActionMap): HelmActionMap | null {
    if (!map) return null;
    const out: HelmActionMap = {};
    for (const key of ['clear', 'compact', 'export'] as const) {
      const value = map[key]?.trim();
      if (value) out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  updateCliType(
    key: string, name: string,
    legacyCommandOrInitialPrompt?: string | SequenceListItem[],
    initialPromptOrDelay?: SequenceListItem[] | number,
    initialPromptDelayOrOptions?: number | CliTypeOptions,
    maybeOptions?: CliTypeOptions,
  ): void {
    this.ensureLoaded();
    if (!this.cliTypeStore.get(key)) {
      throw new Error(`CLI type not found: ${key}`);
    }
    const legacyCommand = typeof legacyCommandOrInitialPrompt === 'string' ? legacyCommandOrInitialPrompt.trim() : '';
    const initialPrompt = Array.isArray(legacyCommandOrInitialPrompt)
      ? legacyCommandOrInitialPrompt
      : (Array.isArray(initialPromptOrDelay) ? initialPromptOrDelay : []);
    const initialPromptDelay = typeof initialPromptDelayOrOptions === 'number'
      ? initialPromptDelayOrOptions
      : (typeof initialPromptOrDelay === 'number' ? initialPromptOrDelay : undefined);
    const options = isCliTypeOptions(initialPromptDelayOrOptions)
      ? initialPromptDelayOrOptions
      : maybeOptions;
    const existing = this.cliTypeStore.get(key)!;
    // Merge — preserve fields not provided (sequences, etc.). A rename touches
    // displayName only: the map key and `id` are identity and never change.
    existing.displayName = name;
    existing.name = name;
    existing.initialPrompt = initialPrompt;
    if (initialPromptDelay !== undefined) existing.initialPromptDelay = initialPromptDelay;
    if (legacyCommand && !options?.spawnCommand) existing.spawnCommand = legacyCommand;

    // Optional fields: undefined = preserve, empty string = clear, value = set
    if (options) {
      if (options.env !== undefined) {
        if (options.env.length === 0) delete existing.env;
        else existing.env = options.env;
      }
      for (const field of ['renameCommand', 'spawnCommand', 'resumeCommand', 'continueCommand', 'submitSuffix'] as const) {
        const val = options[field];
        if (val === undefined) continue;
        if (val === '') { delete (existing as any)[field]; }
        else { (existing as any)[field] = val; }
      }
      if (options.helmPreambleForInterSession !== undefined) {
        if (options.helmPreambleForInterSession === true) {
          delete (existing as any).helmPreambleForInterSession;  // omit default from YAML
        } else {
          existing.helmPreambleForInterSession = false;
        }
      }
      if (options.largeTextAsTempFile !== undefined) {
        if (options.largeTextAsTempFile === false) {
          delete (existing as any).largeTextAsTempFile;  // omit default from YAML
        } else {
          existing.largeTextAsTempFile = true;
        }
      }
      if (options.messReminders !== undefined) {
        if (options.messReminders === true) {
          delete (existing as any).messReminders;  // omit default from YAML
        } else {
          existing.messReminders = false;
        }
      }
      if (options.mouseTracking !== undefined) {
        if (options.mouseTracking === false) {
          delete (existing as any).mouseTracking;  // omit default from YAML
        } else {
          existing.mouseTracking = true;
        }
      }
      if (options.helmActions !== undefined) {
        // undefined = preserve; provided = replace with the cleaned map (empty fields drop, empty map clears).
        const cleaned = this.cleanHelmActions(options.helmActions);
        if (cleaned) existing.helmActions = cleaned;
        else delete (existing as any).helmActions;
      }
    }

    this.cliTypeStore.set(key, existing);
  }

  removeCliType(key: string): void {
    this.ensureLoaded();
    this.cliTypeStore.remove(key);
  }

  reorderCliType(index: number, direction: 'up' | 'down'): void {
    this.ensureLoaded();
    this.cliTypeStore.reorder(index, direction);
  }

  // ---------- Pattern rule CRUD -------------------------------------------

  getPatterns(cliType: string): PatternRule[] {
    this.ensureLoaded();
    return this.cliTypeStore.get(cliType)?.patterns ?? [];
  }

  addPattern(cliType: string, rule: PatternRule): void {
    this.ensureLoaded();
    const entry = this.cliTypeStore.get(cliType);
    if (!entry) throw new Error(`CLI type not found: ${cliType}`);
    if (!entry.patterns) entry.patterns = [];
    entry.patterns.push(rule);
    this.cliTypeStore.set(cliType, entry);
  }

  updatePattern(cliType: string, index: number, rule: PatternRule): void {
    this.ensureLoaded();
    const entry = this.cliTypeStore.get(cliType);
    const patterns = entry?.patterns;
    if (!patterns || index < 0 || index >= patterns.length) {
      throw new Error(`Pattern index ${index} out of range for CLI type: ${cliType}`);
    }
    patterns[index] = rule;
    this.cliTypeStore.set(cliType, entry!);
  }

  removePattern(cliType: string, index: number): void {
    this.ensureLoaded();
    const entry = this.cliTypeStore.get(cliType);
    const patterns = entry?.patterns;
    if (!patterns || index < 0 || index >= patterns.length) {
      throw new Error(`Pattern index ${index} out of range for CLI type: ${cliType}`);
    }
    patterns.splice(index, 1);
    this.cliTypeStore.set(cliType, entry!);
  }

  private buildSpawnConfig(config: CliTypeConfig): SpawnConfig {
    return parseCommandTemplate(config.spawnCommand);
  }

  // ---------- Save helpers ---------------------------------------------

  private saveSettings(): void {
    if (!this.settings) return;
    this.settingsManager.saveNow(this.settings);
  }
}
