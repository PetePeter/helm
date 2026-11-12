import type { ProfileRuntime } from '../session/profile-runtime.js';
import type { ConfigLoader } from '../config/loader.js';
import { getProfilePersistencePaths } from '../session/persistence-paths.js';
import { ProjectStore } from '../session/project-store.js';
import { SessionManager } from '../session/manager.js';
import { PlanManager } from '../session/plan-manager.js';
import { ContextManager } from '../session/context-manager.js';
import { ArtifactManager } from '../session/artifact-manager.js';
import { ArtifactAttachmentManager } from '../session/artifact-attachment-manager.js';
import { ArtifactTempRegistry, attachSessionTempCleanup } from '../session/artifact-temp-registry.js';
import { saveArtifacts, loadArtifacts } from '../session/artifact-persistence.js';
import { DraftManager } from '../session/draft-manager.js';
import { createDraftStore } from '../session/draft-persistence.js';
import { TodoManager } from '../session/todo-manager.js';
import { createTodoStore } from '../session/todo-persistence.js';
import { MemoryPersistence } from '../session/memory-persistence.js';
import { MemoryAttachmentManager } from '../session/memory-attachment-manager.js';
import { MemoryManager } from '../session/memory-manager.js';
import { ScheduledTaskHistoryManager } from '../session/scheduled-task-history-manager.js';
import { ScheduledTaskManager, type ScheduledTaskManagerOptions } from '../session/scheduled-task-manager.js';
import { MessManager } from '../session/mess-manager.js';
import { MessPersistence } from '../session/mess-persistence.js';
import { RecycleBinManager } from '../session/recycle-bin-manager.js';
import { RuntimeGroupManager } from '../session/runtime-group-manager.js';
import { saveRuntimeGroups, loadRuntimeGroups } from '../session/runtime-group-persistence.js';
import { SkillManager } from '../session/skill-manager.js';
import { SkillAnalyticsManager } from '../session/skill-analytics-manager.js';
import { PlanAttachmentManager } from '../session/plan-attachment-manager.js';
import { TimePersistence } from '../session/time-persistence.js';
import { TimeTracker } from '../session/time-tracker.js';
import { EtaPersistence } from '../session/eta-persistence.js';
import { EtaTracker } from '../session/eta-tracker.js';
import { PatternMatcher } from '../session/pattern-matcher.js';
import { StartupPromptWatcher } from '../session/startup-prompt-watcher.js';
import type { PtyManager } from '../session/pty-manager.js';

export interface CreateProfileRuntimeOptions {
  userProfileId: string;
  configDir: string;
  configLoader: ConfigLoader;
  ptyManager: PtyManager;
  scheduledTaskOptions?: ScheduledTaskManagerOptions;
}

/** Build the profile's persisted project/session core from explicit paths. */
export function createProfileRuntime(options: CreateProfileRuntimeOptions): ProfileRuntime {
  const { userProfileId, configDir, configLoader, ptyManager } = options;
  const paths = getProfilePersistencePaths(configDir);
  if (configLoader.getUserProfileId() !== userProfileId) {
    throw new Error(`ConfigLoader profile ${configLoader.getUserProfileId()} does not match runtime ${userProfileId}`);
  }
  if (configLoader.getProfileConfigDir() !== configDir) {
    throw new Error(`ConfigLoader path does not match runtime ${userProfileId}`);
  }
  configLoader.load();
  const projectStore = new ProjectStore(paths.projectsFile);
  configLoader.setProjectStore(projectStore);
  const sessionManager = new SessionManager({
    userProfileId,
    sessionsFile: paths.sessionsFile,
    projectStore,
  });
  const artifactTempRegistry = new ArtifactTempRegistry();
  attachSessionTempCleanup(sessionManager, artifactTempRegistry);
  const artifactAttachmentManager = new ArtifactAttachmentManager(configDir);
  const artifactManager = new ArtifactManager(
    all => saveArtifacts(all, paths.artifactsFile),
    Date.now,
    artifactId => artifactAttachmentManager.deleteForArtifact(artifactId),
  );
  artifactManager.importAll(loadArtifacts(paths.artifactsFile));
  const draftManager = new DraftManager(createDraftStore(paths.draftsDir));
  const todoManager = new TodoManager(createTodoStore(paths.todosDir));
  const memoryPersistence = new MemoryPersistence(paths.memoriesFile);
  const memoryAttachmentManager = new MemoryAttachmentManager(paths.memoryAttachmentsDir);
  const planManager = new PlanManager(projectStore, paths);
  let scheduledTaskManager!: ScheduledTaskManager;
  const memoryManager = new MemoryManager({
    persistence: memoryPersistence,
    attachmentManager: memoryAttachmentManager,
    resolveSessionProject: id => sessionManager.getSession(id)?.projectId ?? null,
    canReadAll: id => sessionManager.getSession(id)?.role === 'operator',
    isProjectShared: projectId => projectStore.getById(projectId)?.memoryPrivate !== true,
    resolveSessionPlan: id => planManager.claimedPlanFor(id)?.id ?? null,
    isDreamSession: id => scheduledTaskManager?.isDreamSession(id) ?? false,
    resolveSessionMission: id => sessionManager.getSession(id)?.mission?.text ?? null,
  });
  const contextManager = new ContextManager(planManager, paths);
  const skillManager = new SkillManager(paths.skillsFile);
  const skillAnalyticsManager = new SkillAnalyticsManager(paths.skillAnalyticsFile);
  const scheduledTaskHistoryManager = new ScheduledTaskHistoryManager(Date.now, paths.scheduledTaskHistoryFile);
  const recycleBinManager = new RecycleBinManager(Date.now, paths.recycleBinFile);
  const runtimeGroupManager = new RuntimeGroupManager(groups => saveRuntimeGroups(groups, paths.runtimeGroupsFile));
  runtimeGroupManager.importAll(loadRuntimeGroups(paths.runtimeGroupsFile));
  scheduledTaskManager = new ScheduledTaskManager(
    sessionManager,
    ptyManager,
    planManager,
    configLoader,
    scheduledTaskHistoryManager,
    projectStore,
    options.scheduledTaskOptions,
    paths.scheduledTasksFile,
  );
  const messManager = new MessManager(sessionManager, projectStore, {
    persistenceFactory: projectId => new MessPersistence(projectId, { directory: paths.messDir }),
  });
  const planAttachmentManager = new PlanAttachmentManager(planManager, configDir);
  const timeTracker = new TimeTracker({
    persistence: new TimePersistence(paths.timeTrackingDir),
    resolve: sessionId => {
      const session = sessionManager.getSession(sessionId);
      if (!session?.workingDir) return null;
      const project = (session.projectId ? projectStore.getById(session.projectId) : undefined)
        ?? projectStore.findByPath(session.workingDir);
      return {
        projectKey: project?.id ?? session.workingDir,
        projectName: project?.name ?? session.workingDir,
        dir: session.workingDir,
        cliType: session.cliType,
      };
    },
  });
  const etaTracker = new EtaTracker({ persistence: new EtaPersistence(paths.timeTrackingDir) });
  const patternMatcher = new PatternMatcher(
    (sessionId, data) => ptyManager.deliverText(sessionId, data),
    // Built-ins follow the user's rules so user rule indices stay stable for cooldowns and edits.
    cliType => [...configLoader.getPatterns(cliType), ...configLoader.getBuiltInPatterns(cliType)],
    cliType => {
      try { return configLoader.resolveCliType(cliType)?.id ?? cliType; }
      catch { return cliType; }
    },
  );
  const startupPromptWatcher = new StartupPromptWatcher({
    getPrompts: cliType => configLoader.getStartupPrompts(cliType),
    updateSession: (sessionId, updates) => sessionManager.updateSession(sessionId, updates),
  });

  return {
    userProfileId,
    configDir,
    paths,
    configLoader,
    projectStore,
    sessionManager,
    planManager,
    contextManager,
    scheduledTaskManager,
    scheduledTaskHistoryManager,
    messManager,
    recycleBinManager,
    runtimeGroupManager,
    artifactManager,
    artifactAttachmentManager,
    artifactTempRegistry,
    draftManager,
    todoManager,
    memoryManager,
    memoryPersistence,
    memoryAttachmentManager,
    planAttachmentManager,
    skillManager,
    skillAnalyticsManager,
    timeTracker,
    etaTracker,
    patternMatcher,
    startupPromptWatcher,
    dispose: () => {
      scheduledTaskManager.stop();
      patternMatcher.dispose();
      startupPromptWatcher.dispose();
      timeTracker.flush();
    },
  };
}
