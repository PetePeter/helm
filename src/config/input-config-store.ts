/**
 * InputConfigStore — manages sticks, dpad, activity, and chipActions in
 * config/input-config.yaml.
 */
import { loadYaml, saveYaml } from './yaml-store.js';
import type { ActivityConfig, ChipbarAction, DpadConfig, StickConfig, StickConfigs } from './loader.js';
import { getGlobalPersistencePaths } from '../session/persistence-paths.js';

const DEFAULT_ACTIVITY: ActivityConfig = { timeoutMs: 5000 };
const DEFAULT_STICK: StickConfig = { mode: 'disabled', deadzone: 0.25, repeatRate: 50 };
const DEFAULT_DPAD: DpadConfig = { initialDelay: 400, repeatRate: 120 };

interface InputConfig {
  sticks?: StickConfigs;
  dpad?: DpadConfig;
  activity?: ActivityConfig;
  chipActions?: ChipbarAction[];
}

export class InputConfigStore {
  private data: InputConfig = {};

  constructor(private readonly configDir: string) {}

  get filePath(): string {
    return getGlobalPersistencePaths(this.configDir).inputConfigFile;
  }

  load(): void {
    this.data = loadYaml<InputConfig>(this.filePath, {});
  }

  getStickConfig(stick: 'left' | 'right'): StickConfig {
    const s = this.data.sticks?.[stick];
    if (!s) return { ...DEFAULT_STICK };
    return {
      mode: s.mode ?? DEFAULT_STICK.mode,
      deadzone: s.deadzone ?? DEFAULT_STICK.deadzone,
      repeatRate: s.repeatRate ?? DEFAULT_STICK.repeatRate,
    };
  }

  getDpadConfig(): DpadConfig {
    return {
      initialDelay: this.data.dpad?.initialDelay ?? DEFAULT_DPAD.initialDelay,
      repeatRate: this.data.dpad?.repeatRate ?? DEFAULT_DPAD.repeatRate,
    };
  }

  getActivityTimeout(): number {
    return this.data.activity?.timeoutMs ?? DEFAULT_ACTIVITY.timeoutMs;
  }

  setActivityTimeout(ms: number): void {
    this.data.activity = { timeoutMs: ms };
    this.save();
  }

  getChipbarActions(): ChipbarAction[] {
    return this.data.chipActions ?? [];
  }

  setChipbarActions(actions: ChipbarAction[]): void {
    this.data.chipActions = actions;
    this.save();
  }

  /** Import partial config from an existing profile during migration. */
  importFrom(partial: Partial<InputConfig>): void {
    if (partial.sticks) this.data.sticks = partial.sticks;
    if (partial.dpad) this.data.dpad = partial.dpad;
    if (partial.activity) this.data.activity = partial.activity;
    if (partial.chipActions?.length) this.data.chipActions = partial.chipActions;
  }

  save(): void {
    saveYaml(this.filePath, this.data);
  }
}
