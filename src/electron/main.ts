/**
 * Electron Main Process
 *
 * Entry point for the Helm desktop application.
 * Manages window creation, IPC communication, and application lifecycle.
 */

import { app, BrowserWindow, Menu, crashReporter, ipcMain, protocol } from 'electron';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { registerIPCHandlers } from './ipc/handlers.js';
import { applyNavigationPolicy } from './navigation-policy.js';
import { WindowManager } from './window-manager.js';
import { resolveWindowIconPath } from './window-icon.js';
import { buildSplashHtml } from './splash-html.js';
import { resolveSplashLogoUrl } from './splash-logo.js';
import { migrateOldPlans } from '../session/plan-migration.js';
import { migrateProjects } from '../session/project-migration.js';
import { migratePromptTemplates } from '../session/prompt-template-migration.js';
import { migrateUserDataFolder } from './user-data-migration.js';
import { configureElectronAppIdentity } from './app-identity.js';
import { ConfigLoader } from '../config/loader.js';
import { logger } from '../utils/logger.js';
import { getRendererHtmlPath, isPackaged, seedConfigIfNeeded, getConfigDir, migrateLegacyUserDataIfNeeded } from '../utils/app-paths.js';
import { registerHelmImgProtocol } from './helm-img-protocol.js';
import { registerHelmArtifactProtocol } from './helm-artifact-protocol.js';

// Register the custom schemes as privileged BEFORE app is ready.
// standard+secure makes them behave like https for CSP/CORS; supportFetchAPI
// allows <img> and fetch() to load from helm-img inside the renderer.
// Neither sets bypassCSP: helm-artifact documents are contained BY their CSP.
protocol.registerSchemesAsPrivileged([
  { scheme: 'helm-img', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'helm-artifact', privileges: { standard: true, secure: true } },
]);

// Enable Chromium gamepad extensions for Bluetooth controller support
app.commandLine.appendSwitch('enable-gamepad-extensions');
app.commandLine.appendSwitch('enable-features', 'WebGamepad');
// Prevent GPU sandbox crashes on hibernate/resume
app.commandLine.appendSwitch('disable-gpu-sandbox');
// Don't kill app after repeated GPU process crashes
app.commandLine.appendSwitch('disable-gpu-process-crash-limit');

// Relocate data written by older builds that used the bare $HOME/Helm fallback
// (pre platform-aware paths) into the correct per-platform userData dir. Must run
// before configureElectronAppIdentity/seedConfigIfNeeded create the new dirs.
const relocated = migrateLegacyUserDataIfNeeded(app.getPath('appData'));
if (relocated.length > 0) {
  logger.info(`[Migration] Relocated legacy $HOME/Helm data: ${relocated.join(', ')}`);
}

configureElectronAppIdentity(app, app.getPath('appData'));

// Enable crash reporter to capture native crash dumps for diagnosis
crashReporter.start({
  submitURL: '',
  uploadToServer: false,
});

const previousCrash = crashReporter.getLastCrashReport();
if (previousCrash) {
  logger.error(`[Main] Previous native crash report: ${JSON.stringify(previousCrash)}`);
}

app.on('child-process-gone', (_event, details) => {
  logger.error(`[Main] Child process gone: type=${details.type}, reason=${details.reason}, exitCode=${details.exitCode}`);
});

// Set app identity so Windows toast notifications show our name, not "Electron"
app.setAppUserModelId('com.helm.desktop');

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let cleanupIPC: (() => Promise<void>) | null = null;
let isCleaningUp = false;
let allowMainWindowClose = false;
let closeConfirmPending = false;
let windowBounds = { width: 1280, height: 800, x: undefined as number | undefined, y: undefined as number | undefined };
let mainWindowReadyToShow = false;
let rendererStartupReady = false;
let startupFallbackTimer: ReturnType<typeof setTimeout> | null = null;
const configLoader = new ConfigLoader();
const RESTART_STARTUP_DELAY_MS = 3000;
// Upper bound on shutdown cleanup; past this we quit regardless so a wedged
// resource can never block the restart/relaunch flow.
const CLEANUP_TIMEOUT_MS = 5000;

function parseStartupDelayMs(args: string[]): number {
  const arg = args.find(value => value.startsWith('--startup-delay='));
  if (!arg) return 0;
  const parsed = Number.parseInt(arg.split('=')[1] ?? '', 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

const startupDelayMs = parseStartupDelayMs(process.argv);

function readWindowBounds(): void {
  windowBounds = { width: 1280, height: 800, x: undefined as number | undefined, y: undefined as number | undefined };
  try {
    const prefs = configLoader.getSidebarPrefs();
    if (prefs.width) windowBounds.width = Math.max(prefs.width, 800);
    if (prefs.height) windowBounds.height = prefs.height;
    if (prefs.x !== undefined) windowBounds.x = prefs.x;
    if (prefs.y !== undefined) windowBounds.y = prefs.y;
  } catch {
    logger.warn('[Main] Could not read window prefs, using defaults');
  }
}

function clearStartupFallbackTimer(): void {
  if (!startupFallbackTimer) return;
  clearTimeout(startupFallbackTimer);
  startupFallbackTimer = null;
}

function closeSplashWindow(): void {
  clearStartupFallbackTimer();
  if (!splashWindow || splashWindow.isDestroyed()) {
    splashWindow = null;
    return;
  }
  splashWindow.close();
  splashWindow = null;
}

function maybeShowMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindowReadyToShow || !rendererStartupReady) return;

  if (!windowBounds.x && !windowBounds.y) {
    mainWindow.maximize();
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show();
    logger.info('[Main] Window shown');
  }
  mainWindow.focus();
  closeSplashWindow();
}

function createSplashWindow(windowIcon?: string): void {
  closeSplashWindow();
  const splashLogoUrl = resolveSplashLogoUrl({
    appPath: app.getAppPath(),
    baseDir: __dirname,
  });

  splashWindow = new BrowserWindow({
    width: 460,
    height: 320,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    movable: false,
    fullscreenable: false,
    show: false,
    center: true,
    skipTaskbar: true,
    backgroundColor: '#0a0a0a',
    alwaysOnTop: true,
    icon: windowIcon,
  });

  splashWindow.setMenuBarVisibility(false);
  void splashWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(buildSplashHtml(app.getVersion(), splashLogoUrl))}`);
  splashWindow.once('ready-to-show', () => splashWindow?.show());
  splashWindow.on('closed', () => {
    splashWindow = null;
  });
}

/**
 * Create the main application window.
 *
 * Now a maximised desktop app (no longer a sidebar) so embedded
 * terminals have room to render.  Window bounds are persisted and
 * restored on next launch.
 */
function createWindow(): void {
  const preloadPath = join(__dirname, 'preload.cjs');
  logger.debug(`[Main] Preload path: ${preloadPath}`);

  readWindowBounds();
  mainWindowReadyToShow = false;
  rendererStartupReady = false;

  const windowIcon = resolveWindowIconPath(__dirname);
  createSplashWindow(windowIcon);

  mainWindow = new BrowserWindow({
    width: windowBounds.width,
    height: windowBounds.height,
    x: windowBounds.x,
    y: windowBounds.y,
    minWidth: 640,
    minHeight: 400,
    frame: true,
    resizable: true,
    backgroundColor: '#0a0a0a',
    show: false,
    icon: windowIcon,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // Required: preload needs Node.js APIs for contextBridge IPC
    },
    title: `Helm — steer your fleet of agents v${app.getVersion()}`,
  });

  // Confine this privileged window to its own app content (deny remote navigation).
  applyNavigationPolicy(mainWindow);

  // Load the renderer HTML (__dirname-relative, works inside asar)
  const rendererPath = getRendererHtmlPath(__dirname);
  mainWindow.loadFile(rendererPath);

  // Keep our BrowserWindow title (prevents HTML <title> from overriding it)
  mainWindow.on('page-title-updated', (e) => e.preventDefault());

  // Wait for both Chromium paint readiness and renderer bootstrap readiness.
  mainWindow.once('ready-to-show', () => {
    mainWindowReadyToShow = true;
    maybeShowMainWindow();
  });

  // Preload check
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.executeJavaScript('typeof window.gamepadCli')
      .then(result => logger.debug(`[Main] Preload check: window.gamepadCli is ${result}`))
      .catch(err => logger.error(`[Main] Preload check failed: ${err}`));
  });

  // Log renderer console output
  // TRACE: forward ALL renderer console logs for pipeline debugging
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    logger.info(`[WebContents:${level}] ${message} (${sourceId}:${line})`);
  });

  // Renderer crash recovery — Chromium GPU process often crashes on hibernate resume
  let lastReloadTime = 0;
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error(`[Main] Render process gone: reason=${details.reason}, exitCode=${details.exitCode}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      const now = Date.now();
      if (now - lastReloadTime < 5000) {
        logger.error('[Main] Renderer crashing in a loop — not reloading again');
        return;
      }
      lastReloadTime = now;
      logger.info('[Main] Attempting renderer reload after crash');
      mainWindowReadyToShow = false;
      rendererStartupReady = false;
      createSplashWindow(windowIcon);
      mainWindow.webContents.reload();
    }
  });

  mainWindow.webContents.on('unresponsive', () => {
    logger.warn('[Main] Renderer became unresponsive');
  });

  mainWindow.webContents.on('responsive', () => {
    logger.info('[Main] Renderer became responsive again');
  });

  // DevTools — only open via Ctrl+Shift+I (not auto-opened)
  // if (process.env.NODE_ENV !== 'production' && !app.isPackaged) {
  //   mainWindow.webContents.openDevTools();
  // }

  // Persist window bounds on resize/move (debounced)
  let boundsTimer: ReturnType<typeof setTimeout> | null = null;
  const persistBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMaximized()) return;
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const bounds = mainWindow.getBounds();
      try {
        configLoader.setSidebarPrefs({ width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y });
      } catch { /* config may not be ready */ }
    }, 500);
  };
  mainWindow.on('resize', persistBounds);
  mainWindow.on('move', persistBounds);

  mainWindow.on('close', (event) => {
    if (allowMainWindowClose || isCleaningUp) return;
    event.preventDefault();

    if (closeConfirmPending) {
      mainWindow?.focus();
      return;
    }

    closeConfirmPending = true;
    mainWindow?.show();
    mainWindow?.focus();
    mainWindow?.webContents.send('app:close-request');
  });

  mainWindow.on('closed', () => {
    allowMainWindowClose = false;
    closeConfirmPending = false;
    clearStartupFallbackTimer();
    closeSplashWindow();
    mainWindow = null;
    mainWindowReadyToShow = false;
    rendererStartupReady = false;
    logger.info('[Main] Window closed');
  });

  clearStartupFallbackTimer();
  startupFallbackTimer = setTimeout(() => {
    logger.warn('[Main] Renderer startup-ready signal timed out; showing main window anyway');
    rendererStartupReady = true;
    maybeShowMainWindow();
  }, 15000);

  logger.info(`[Main] Window created (${windowBounds.width}x${windowBounds.height})`);
}

/**
 * Application lifecycle - Ready
 */
app.whenReady().then(async () => {
  logger.info('[Main] App ready');
  logger.info(`[Main] Crash dumps directory: ${app.getPath('crashDumps')}`);

  // Migrate user data folder from old name to new name (packaged builds only)
  migrateUserDataFolder(process.env.APPDATA || process.env.HOME || '.', app.isPackaged);

  // Belt-and-suspenders: seed config from main.ts in case module-level seed didn't run
  const bundled = isPackaged(__dirname)
    ? join(__dirname, '..', 'config')
    : join(process.cwd(), 'src', 'config');
  const target = getConfigDir(__dirname);
  seedConfigIfNeeded(bundled, target);

  // Migrate monolithic plans.yaml → individual files if still present
  try {
    const r = migrateOldPlans();
    if (r.migratedPlans > 0 || r.migratedDeps > 0) {
      logger.info(`[Main] Plan migration: ${r.migratedPlans} plan(s), ${r.migratedDeps} dep(s)`);
    }
  } catch (err) {
    logger.error(`[Main] Plan migration failed: ${err}`);
  }

  try {
    const r = migrateProjects();
    if (r.migratedProjects > 0 || r.updatedPlans > 0 || r.updatedSequences > 0 || r.updatedSessions > 0) {
      logger.info(`[Main] Project migration: ${r.migratedProjects} project(s), ${r.updatedPlans} plan(s), ${r.updatedSequences} sequence(s), ${r.updatedSessions} session(s)`);
    }
  } catch (err) {
    logger.error(`[Main] Project migration failed: ${err}`);
  }

  // One-time: merge profile `sequences` into the global prompt-templates.yaml.
  // Runs after seeding so seeded profiles are present; idempotent on reboot.
  try {
    migratePromptTemplates();
  } catch (err) {
    logger.error(`[Main] Prompt-template migration failed: ${err}`);
  }

  // Register IPC handlers (passes __dirname for temp file cleanup on startup)
  const ipc = registerIPCHandlers(__dirname, configLoader, { startupDelayMs });
  cleanupIPC = ipc.cleanup;
  const windowManager = ipc.windowManager;
  ipc.helmControlService.on('restart-requested', () => {
    logger.info('[Main] Restart requested - relaunching with startup delay');
    const relaunchArgs = process.argv
      .slice(1)
      .filter(arg => !arg.startsWith('--startup-delay='))
      .concat([`--startup-delay=${RESTART_STARTUP_DELAY_MS}`]);
    app.relaunch({ args: relaunchArgs });
    app.quit();
  });

  // Start watching for incoming plan files from CLIs
  ipc.incomingWatcher.start();

  // Remove default application menu (no File/Edit/View/Window/Help needed)
  Menu.setApplicationMenu(null);

  // Register helm-img:// handler so the renderer can load local image files
  // without loosening webSecurity or file:// access.
  registerHelmImgProtocol(protocol);

  // Register helm-artifact:// so HTML artifacts render as their own isolated
  // document with an authoritative CSP header (srcdoc would inherit the
  // renderer's stricter policy and silently block artifact scripts).
  registerHelmArtifactProtocol(protocol);

  // Create main window
  createWindow();

  // Register main window with WindowManager
  if (mainWindow) {
    windowManager.setMainWindow(mainWindow);
  }

  // Handle macOS dock behavior
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

ipcMain.on('app:startupReady', (event) => {
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  if (!senderWin || senderWin.isDestroyed()) return;

  rendererStartupReady = true;
  logger.info('[Main] Renderer signaled startup ready');
  maybeShowMainWindow();
});

ipcMain.on('app:close-confirm-response', (_event, confirmed: boolean) => {
  closeConfirmPending = false;
  if (!confirmed || !mainWindow || mainWindow.isDestroyed()) return;

  allowMainWindowClose = true;
  mainWindow.close();
});

/**
 * Application lifecycle - All windows closed
 */
app.on('window-all-closed', () => {
  logger.info('[Main] All windows closed');

  // On macOS, don't quit the app
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/**
 * Application lifecycle - Before quit
 */
app.on('before-quit', (event) => {
  // Nothing to await — let the default quit proceed.
  if (!cleanupIPC) return;

  // Re-entrancy guard: once cleanup is running we must not start it again. The
  // first pass prevents the quit, awaits a clean shutdown (notably releasing the
  // fixed MCP port so the relaunched instance can bind it), then exits for real.
  if (isCleaningUp) return;
  isCleaningUp = true;
  event.preventDefault();

  logger.info('[Main] App quitting — running cleanup before exit');
  closeSplashWindow();

  const cleanup = cleanupIPC;
  cleanupIPC = null;
  // Never let a wedged resource block quit/relaunch — cap the wait, then proceed.
  const cleanupWithTimeout = Promise.race([
    cleanup(),
    new Promise<void>(resolve => setTimeout(() => {
      logger.warn('[Main] Cleanup timed out — quitting anyway');
      resolve();
    }, CLEANUP_TIMEOUT_MS)),
  ]);
  void cleanupWithTimeout
    .catch((error) => logger.error(`[Main] Cleanup failed during quit: ${error}`))
    .finally(() => {
      // Re-issue quit; the guard above now lets the default proceed, emitting
      // will-quit/quit so a pending app.relaunch() is honored.
      logger.info('[Main] Cleanup complete — quitting');
      app.quit();
    });
});

/**
 * Application lifecycle - Will quit
 */
app.on('will-quit', (event) => {
  logger.info('[Main] App will quit');

  // Prevent default quit to allow cleanup
  // event.preventDefault();

  // Cleanup will be handled by before-quit
});

/**
 * Handle uncaught errors
 */
process.on('uncaughtException', (error) => {
  logger.error(`[Main] Uncaught exception: ${error.stack || error}`);
  // Don't exit — try to keep the app alive
});

process.on('unhandledRejection', (reason) => {
  logger.error(`[Main] Unhandled rejection: ${reason}`);
  // Don't exit — try to keep the app alive
});

/**
 * Export for testing
 */
export { mainWindow };
