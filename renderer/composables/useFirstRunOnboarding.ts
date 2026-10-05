import { computed, ref } from 'vue';
import { normalizeDirPath } from '../utils.js';

export type OnboardingStage = 'cli' | 'directory' | 'prompt' | 'success' | 'configure';

export interface OnboardingTool {
  id: string;
  name: string;
}

export interface OnboardingProject {
  name: string;
  canonicalPath: string;
  alternatePaths?: string[];
}

export interface OnboardingDirectory {
  name: string;
  path: string;
}

export interface FirstRunOnboardingDeps {
  getCompleted(): Promise<boolean>;
  setCompleted(completed: boolean): Promise<{ success: boolean; error?: string }>;
  getTools(): Promise<OnboardingTool[]>;
  getProjects(): Promise<OnboardingProject[]>;
  browseDirectory(): Promise<string | null>;
  createProject(dirPath: string): Promise<{ success: boolean; error?: string }>;
  spawnSession(cliType: string, dirPath: string, prompt: string): Promise<boolean>;
  openSettings(tabId: string): void;
}

const FIRST_PROMPT = 'Look through this project and explain how it works.';

export function useFirstRunOnboarding(deps: FirstRunOnboardingDeps) {
  const visible = ref(false);
  const initialized = ref(false);
  const completed = ref(false);
  const stage = ref<OnboardingStage>('cli');
  const tools = ref<OnboardingTool[]>([]);
  const directories = ref<OnboardingDirectory[]>([]);
  const selectedCli = ref('');
  const selectedDirectory = ref('');
  const prompt = ref(FIRST_PROMPT);
  const busy = ref(false);
  const error = ref('');

  const hasTools = computed(() => tools.value.length > 0);
  const hasDirectories = computed(() => directories.value.length > 0);

  async function loadChoices(): Promise<void> {
    const [nextTools, projects] = await Promise.all([deps.getTools(), deps.getProjects()]);
    tools.value = nextTools;
    directories.value = projectDirectories(projects);
    if (!tools.value.some(tool => tool.id === selectedCli.value)) {
      selectedCli.value = tools.value[0]?.id ?? '';
    }
    if (!directories.value.some(directory => normalizeDirPath(directory.path) === normalizeDirPath(selectedDirectory.value))) {
      selectedDirectory.value = directories.value[0]?.path ?? '';
    }
  }

  async function initialize(): Promise<void> {
    if (initialized.value) return;
    initialized.value = true;
    try {
      completed.value = await deps.getCompleted();
      if (completed.value) return;
      await loadChoices();
      visible.value = true;
    } catch (cause) {
      // A failed config read should not block the main app or interrupt an
      // existing user. The header entry still lets them open the guide later.
      console.error('[Onboarding] Failed to load setup state:', cause);
    }
  }

  async function open(): Promise<void> {
    error.value = '';
    try {
      completed.value = await deps.getCompleted();
      if (completed.value) {
        stage.value = 'configure';
        visible.value = true;
        return;
      }
      await loadChoices();
      stage.value = 'cli';
      visible.value = true;
    } catch (cause) {
      error.value = `Could not load setup information: ${String(cause)}`;
      visible.value = true;
    }
  }

  function chooseCli(cliType: string): void {
    selectedCli.value = cliType;
    error.value = '';
  }

  function continueFromCli(): void {
    error.value = '';
    if (!hasTools.value || !selectedCli.value) {
      error.value = 'Add a CLI tool in Settings to continue.';
      return;
    }
    stage.value = 'directory';
  }

  function chooseExistingDirectory(dirPath: string): void {
    selectedDirectory.value = dirPath;
    error.value = '';
  }

  async function browseForDirectory(): Promise<void> {
    error.value = '';
    const dirPath = await deps.browseDirectory();
    if (!dirPath) return;
    busy.value = true;
    try {
      const existing = directories.value.find(item => normalizeDirPath(item.path) === normalizeDirPath(dirPath));
      if (!existing) {
        const result = await deps.createProject(dirPath);
        if (!result.success) {
          await loadChoices();
          const duplicate = directories.value.find(item => normalizeDirPath(item.path) === normalizeDirPath(dirPath));
          if (!duplicate) {
            error.value = result.error || 'Could not add that folder as a project.';
            return;
          }
        } else {
          await loadChoices();
        }
      }
      selectedDirectory.value = dirPath;
    } catch (cause) {
      error.value = `Could not add that folder: ${String(cause)}`;
    } finally {
      busy.value = false;
    }
  }

  function continueFromDirectory(): void {
    error.value = '';
    if (!selectedDirectory.value) {
      error.value = 'Choose or add a project folder to continue.';
      return;
    }
    stage.value = 'prompt';
  }

  async function startSession(): Promise<void> {
    error.value = '';
    if (!selectedCli.value) {
      stage.value = 'cli';
      error.value = 'Choose a CLI tool to continue.';
      return;
    }
    if (!selectedDirectory.value) {
      stage.value = 'directory';
      error.value = 'Choose or add a project folder to continue.';
      return;
    }
    if (!prompt.value.trim()) {
      error.value = 'Write a short first prompt to continue.';
      return;
    }

    busy.value = true;
    try {
      const started = await deps.spawnSession(selectedCli.value, selectedDirectory.value, prompt.value.trim());
      if (!started) {
        error.value = 'Helm could not start this CLI. Check its command in Settings → Tools and try again.';
        return;
      }
      completed.value = true;
      stage.value = 'success';
      const saved = await deps.setCompleted(true);
      if (!saved.success) error.value = saved.error || 'Session started, but setup progress could not be saved.';
    } catch (cause) {
      error.value = `Helm could not start this session: ${String(cause)}`;
    } finally {
      busy.value = false;
    }
  }

  async function showConfiguration(): Promise<void> {
    error.value = '';
    if (!completed.value) {
      const saved = await deps.setCompleted(true);
      if (!saved.success) {
        error.value = saved.error || 'Could not save setup progress.';
        return;
      }
      completed.value = true;
    }
    stage.value = 'configure';
  }

  async function finish(): Promise<void> {
    error.value = '';
    if (!completed.value) {
      const saved = await deps.setCompleted(true);
      if (!saved.success) {
        error.value = saved.error || 'Could not save setup progress.';
        return;
      }
      completed.value = true;
    }
    visible.value = false;
  }

  function openSettings(tabId: string): void {
    visible.value = false;
    deps.openSettings(tabId);
  }

  function back(): void {
    error.value = '';
    if (stage.value === 'directory') stage.value = 'cli';
    else if (stage.value === 'prompt') stage.value = 'directory';
    else if (stage.value === 'configure') stage.value = completed.value ? 'success' : 'cli';
  }

  return {
    visible, initialized, completed, stage, tools, directories, selectedCli,
    selectedDirectory, prompt, busy, error, hasTools, hasDirectories,
    initialize, open, chooseCli, continueFromCli, chooseExistingDirectory,
    browseForDirectory, continueFromDirectory, startSession, showConfiguration,
    finish, openSettings, back,
  };
}

function projectDirectories(projects: OnboardingProject[]): OnboardingDirectory[] {
  const seen = new Set<string>();
  const result: OnboardingDirectory[] = [];
  for (const project of projects) {
    for (const projectPath of [project.canonicalPath, ...(project.alternatePaths ?? [])]) {
      const key = normalizeDirPath(projectPath);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push({ name: project.name, path: projectPath });
    }
  }
  return result;
}
