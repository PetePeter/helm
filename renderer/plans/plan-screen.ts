import { reactive, watch } from 'vue';
import type { PlanDependency, PlanItem, PlanSequence, PlanStatus, PlanType } from '../../src/types/plan.js';
import type { ContextBindingTargetType, ContextNode } from '../../src/types/context.js';
import type { LayoutNode, LayoutResult } from './plan-layout.js';
import { computeLayout } from './plan-layout.js';
import { deliverPromptSequence } from '../sequence-delivery.js';
import { hidePlanDeleteConfirm, showPlanDeleteConfirm } from '../stores/modal-bridge.js';
import { bulkCleanup, setBulkCleanupCallback, showPlanHelpModal, hidePlanHelpModal, isPlanHelpVisible } from '../stores/modal-bridge.js';
import { state } from '../state.js';
import { getActiveSessionDir } from '../stores/app.js';
import { registerView, showView, currentView, type ViewMountContext } from '../main-view/main-view-manager.js';
import { registerKeyHandler, type KeyContext } from '../keyboard/router.js';
import { PANE_PLAN_SCREEN } from '../dock-types.js';
import { currentWindowIdentity, windowIdentityKey } from '../window-identity.js';
import { pathsMatch } from '../session-groups.js';
import {
  attachmentsClient,
  configClient,
  contextsClient,
  dialogClient,
  incomingClient,
  plansClient,
} from '../ipc/clients.js';

export type TriState = 'either' | 'yes' | 'no';
type TypeFilterKey = 'bug' | 'feature' | 'research' | 'untyped';
type StatusFilterKey = 'planning' | 'ready' | 'coding' | 'review' | 'blocked' | 'done';
type AttachmentFilterKey = 'yes' | 'no';

function makeDefaultFilters() {
  return {
    types: { bug: 'either', feature: 'either', research: 'either', untyped: 'either' } as Record<TypeFilterKey, TriState>,
    statuses: { planning: 'either', ready: 'either', coding: 'either', review: 'either', blocked: 'either', done: 'either' } as Record<StatusFilterKey, TriState>,
    hasAttachment: { yes: 'either', no: 'either' } as Record<AttachmentFilterKey, TriState>,
    auto: 'either' as TriState,
  };
}

export interface PlanEditorCallbacks {
  onSave: (updates: { title: string; description: string; status: PlanStatus; stateInfo?: string; type?: PlanType; autoImplement?: boolean; completionRecap?: boolean }) => void | Promise<void>;
  onDelete: () => void | Promise<void>;
  onDone?: () => void | Promise<void>;
  onApply?: () => void | Promise<void>;
  onClose?: () => void;
}

export const planScreenState = reactive({
  visible: false,
  currentDir: '',
  items: [] as PlanItem[],
  deps: [] as PlanDependency[],
  sequences: [] as PlanSequence[],
  contexts: [] as Array<ContextNode & { sequenceIds?: string[]; planIds?: string[] }>,
  layout: { nodes: [], width: 0, height: 0 } as LayoutResult,
  selectedId: null as string | null,
  selectedContextId: null as string | null,
  selectedIds: new Set<string>(),
  editingId: null as string | null,
  editingContextId: null as string | null,
  notice: '',
  relatedFocusRootId: null as string | null,
  relatedFocusIds: new Set<string>(),
  relatedTransientIds: new Set<string>(),
  filters: makeDefaultFilters(),
  attachmentHasAny: {} as Record<string, boolean>,
});

interface SetPlanDataOptions {
  preserveTransientFocus?: boolean;
}

interface RefreshCanvasOptions {
  preserveTransientFocus?: boolean;
}

let fitActiveCallback: (() => void) | null = null;
let closeCallback: (() => void) | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
let latestPlanDataLoadToken = 0;
let dockPaneMounted = false;
let overlayMounted = false;

interface WindowCallbacks {
  planEditorOpener: ((sessionId: string, plan: PlanItem, callbacks: PlanEditorCallbacks) => void) | null;
  draftEditorCloser: (() => void) | null;
  draftEditorVisibilityChecker: (() => boolean) | null;
  contextEditorOpener: ((context: { id: string; title: string; type: string; permission: 'readonly' | 'writable'; content: string; planIds?: string[]; sequenceIds?: string[] }, callbacks: { onSave: (updates: { title: string; content: string; type: string; permission: 'readonly' | 'writable' }) => void; onDelete: () => void; onUnbind?: (targetType: ContextBindingTargetType, targetId: string) => void; onClose?: () => void }) => void) | null;
  planChangesChecker: (() => boolean) | null;
}

// Keyed per window, not per pop-out flag: several planner pop-outs can be open
// at once, and each must own its own editor callbacks.
const callbackRegistry = new Map<string, WindowCallbacks>();

function getWindowCallbacks(): WindowCallbacks {
  const key = windowIdentityKey(currentWindowIdentity());
    if (!callbackRegistry.has(key)) {
    callbackRegistry.set(key, {
      planEditorOpener: null,
      draftEditorCloser: null,
      draftEditorVisibilityChecker: null,
      contextEditorOpener: null,
      planChangesChecker: null,
    });
  }
  return callbackRegistry.get(key)!;
}

let filtersLoaded = false;

function coerceTriState(value: unknown): TriState {
  return value === 'yes' || value === 'no' || value === 'either' ? value : 'either';
}

function coerceTriStateGroup<T extends string>(defaults: Record<T, TriState>, saved: unknown): Record<T, TriState> {
  const source = saved && typeof saved === 'object' ? saved as Record<string, unknown> : {};
  return Object.fromEntries(
    Object.keys(defaults).map((key) => [key, coerceTriState(source[key])]),
  ) as Record<T, TriState>;
}

function cycleTriState(current: TriState): TriState {
  return current === 'either' ? 'yes' : current === 'yes' ? 'no' : 'either';
}

function matchesTriStateGroup<T extends string>(group: Record<T, TriState>, key: T): boolean {
  const state = group[key] ?? 'either';
  if (state === 'no') return false;
  const hasYes = Object.values(group).some((value) => value === 'yes');
  return hasYes ? state === 'yes' : true;
}

function snapshotFilterPreferences() {
  return {
    types: { ...planScreenState.filters.types },
    statuses: { ...planScreenState.filters.statuses },
    hasAttachment: { ...planScreenState.filters.hasAttachment },
    auto: planScreenState.filters.auto,
  };
}

watch(
  () => ({
    types: planScreenState.filters.types,
    statuses: planScreenState.filters.statuses,
    hasAttachment: planScreenState.filters.hasAttachment,
    auto: planScreenState.filters.auto,
  }),
  () => {
    if (!filtersLoaded) return;
    void saveFilterPreferences();
  },
  { deep: true },
);

async function loadFilterPreferences(): Promise<void> {
  try {
    const saved = await configClient.configGetPlanFilters();
    const defaults = makeDefaultFilters();
    planScreenState.filters.types = coerceTriStateGroup(defaults.types, saved.types);
    planScreenState.filters.statuses = coerceTriStateGroup(defaults.statuses, saved.statuses);
    planScreenState.filters.hasAttachment = coerceTriStateGroup(defaults.hasAttachment, saved.hasAttachment);
    planScreenState.filters.auto = coerceTriState(saved.auto);
  } catch (err) {
    console.error('[PlanScreen] Failed to load filter preferences:', err);
  } finally {
    filtersLoaded = true;
  }
}

async function saveFilterPreferences(): Promise<void> {
  try {
    await configClient.configSetPlanFilters(snapshotFilterPreferences());
  } catch (err) {
    console.error('[PlanScreen] Failed to save filter preferences:', err);
  }
}

// Eagerly load persisted filters so they're ready before first render
void loadFilterPreferences();

export function setPlanScreenFitCallback(fn: () => void): void { fitActiveCallback = fn; }
export function setPlanScreenCloseCallback(fn: () => void): void { closeCallback = fn; }
export function setPlanEditorOpener(fn: WindowCallbacks['planEditorOpener']) { getWindowCallbacks().planEditorOpener = fn; }
export function setDraftEditorCloser(fn: WindowCallbacks['draftEditorCloser']) { getWindowCallbacks().draftEditorCloser = fn; }
export function setDraftEditorVisibilityChecker(fn: WindowCallbacks['draftEditorVisibilityChecker']) { getWindowCallbacks().draftEditorVisibilityChecker = fn; }
export function setPlanChangesChecker(fn: WindowCallbacks['planChangesChecker']) { getWindowCallbacks().planChangesChecker = fn; }
export function setPlanScreenContextEditorOpener(fn: WindowCallbacks['contextEditorOpener']) { getWindowCallbacks().contextEditorOpener = fn; }

function getLayoutNodes(): LayoutNode[] {
  return planScreenState.layout.nodes;
}

function getNavigableLayoutNodes(): LayoutNode[] {
  if (!planScreenState.relatedFocusRootId) return getLayoutNodes();
  if (planScreenState.selectedId && isPlanRelatedBackground(planScreenState.selectedId)) {
    return getLayoutNodes();
  }
  return getLayoutNodes().filter((node) => !isPlanRelatedBackground(node.id));
}

function getSelectedItem(): PlanItem | null {
  return planScreenState.selectedId
    ? planScreenState.items.find((item) => item.id === planScreenState.selectedId) ?? null
    : null;
}

function getSelectedContext(): (ContextNode & { sequenceIds?: string[]; planIds?: string[] }) | null {
  return planScreenState.selectedContextId
    ? planScreenState.contexts.find((context) => context.id === planScreenState.selectedContextId) ?? null
    : null;
}

function getPlanItemById(planId: string): PlanItem | null {
  return planScreenState.items.find((item) => item.id === planId) ?? null;
}

function matchesFilters(item: PlanItem): boolean {
  const { filters, attachmentHasAny } = planScreenState;

  const typeKey: TypeFilterKey = item.type ?? 'untyped';
  if (!matchesTriStateGroup(filters.types, typeKey)) return false;
  if (!matchesTriStateGroup(filters.statuses, item.status)) return false;

  const hasAtt = attachmentHasAny[item.id] ?? false;
  if (!matchesTriStateGroup(filters.hasAttachment, hasAtt ? 'yes' : 'no')) return false;

  if (filters.auto === 'yes' && !item.autoImplement) return false;
  if (filters.auto === 'no' && item.autoImplement) return false;

  return true;
}

function getFilteredItems(): PlanItem[] {
  return planScreenState.items.filter(matchesFilters);
}

function getFilteredDeps(allDeps: PlanDependency[]): PlanDependency[] {
  const filteredIds = new Set(getFilteredItems().map(i => i.id));
  return allDeps.filter(dep => filteredIds.has(dep.fromId) && filteredIds.has(dep.toId));
}

export function computeConnectedPlanIds(rootId: string | null, deps: PlanDependency[]): Set<string> {
  if (!rootId) return new Set();
  const connected = new Map<string, Set<string>>();
  for (const dep of deps) {
    if (!connected.has(dep.fromId)) connected.set(dep.fromId, new Set());
    if (!connected.has(dep.toId)) connected.set(dep.toId, new Set());
    connected.get(dep.fromId)?.add(dep.toId);
    connected.get(dep.toId)?.add(dep.fromId);
  }

  const visited = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    for (const next of connected.get(current) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push(next);
    }
  }
  return visited;
}

function setRelatedTransientIds(ids: Iterable<string>): void {
  planScreenState.relatedTransientIds = new Set(ids);
}

function refreshRelatedFocus(): void {
  const rootId = planScreenState.relatedFocusRootId;
  if (!rootId) {
    planScreenState.relatedFocusIds = new Set();
    setRelatedTransientIds([]);
    return;
  }

  const itemIds = new Set(planScreenState.items.map((item) => item.id));
  if (!itemIds.has(rootId)) {
    planScreenState.relatedFocusRootId = null;
    planScreenState.relatedFocusIds = new Set();
    setRelatedTransientIds([]);
    return;
  }

  const connectedIds = computeConnectedPlanIds(rootId, planScreenState.deps);
  const visibleConnectedIds = new Set([...connectedIds].filter((id) => itemIds.has(id)));
  planScreenState.relatedFocusIds = visibleConnectedIds;
  setRelatedTransientIds([...planScreenState.relatedTransientIds].filter((id) => itemIds.has(id) && !visibleConnectedIds.has(id)));
}

function isPlanRelatedForeground(id: string): boolean {
  return !planScreenState.relatedFocusRootId
    || planScreenState.relatedFocusIds.has(id)
    || planScreenState.relatedTransientIds.has(id);
}

export function isPlanRelatedBackground(id: string): boolean {
  return !isPlanRelatedForeground(id);
}

function setPlanData(
  items: PlanItem[],
  deps: PlanDependency[],
  sequences: PlanSequence[] = [],
  contexts: Array<ContextNode & { sequenceIds?: string[]; planIds?: string[] }> = [],
  options?: SetPlanDataOptions,
): void {
  if (!options?.preserveTransientFocus) {
    setRelatedTransientIds([]);
  }
  planScreenState.items = items;
  planScreenState.deps = deps;
  planScreenState.sequences = sequences;
  planScreenState.contexts = contexts;
  refreshRelatedFocus();
  const filteredItems = getFilteredItems();
  const filteredDeps = getFilteredDeps(deps);
  planScreenState.layout = computeLayout(filteredItems, filteredDeps);
}

function clearNotice(): void {
  if (noticeTimer) {
    clearTimeout(noticeTimer);
    noticeTimer = null;
  }
  planScreenState.notice = '';
}

function showBriefNotice(message: string): void {
  clearNotice();
  planScreenState.notice = message;
  noticeTimer = setTimeout(() => {
    planScreenState.notice = '';
    noticeTimer = null;
  }, 3000);
}

function syncSelection(): void {
  if (planScreenState.selectedId && !planScreenState.items.some((item) => item.id === planScreenState.selectedId)) {
    planScreenState.selectedId = null;
    planScreenState.editingId = null;
  }
  if (planScreenState.selectedContextId && !planScreenState.contexts.some((context) => context.id === planScreenState.selectedContextId)) {
    planScreenState.selectedContextId = null;
  }
}

async function loadPlanData(dirPath: string, context?: ViewMountContext, options?: SetPlanDataOptions): Promise<void> {
  const loadToken = ++latestPlanDataLoadToken;
  const [items, deps, sequences, contexts] = await Promise.all([
    plansClient.planList(dirPath),
    plansClient.planDeps(dirPath),
    plansClient.planSequenceList?.(dirPath) ?? Promise.resolve([]),
    contextsClient.planContextList?.(dirPath) ?? Promise.resolve([]),
  ]);
  if ((context && !context.isActive()) || loadToken !== latestPlanDataLoadToken) return;

  // Fetch attachments before setPlanData to avoid a second layout pass
  const attachmentHasAny = items.length > 0
    ? await attachmentsClient.planAttachmentHasAny(items.map((item) => item.id))
    : {};
  if ((context && !context.isActive()) || loadToken !== latestPlanDataLoadToken) return;

  planScreenState.attachmentHasAny = attachmentHasAny;
  setPlanData(items, deps, sequences, contexts, options);

  syncSelection();
  if (!planScreenState.selectedId && planScreenState.layout.nodes.length > 0) {
    const first = planScreenState.layout.nodes.find((node) => node.layer === 0 && node.order === 0) ?? planScreenState.layout.nodes[0];
    planScreenState.selectedId = first.id;
  }
  if (items.length === 0) {
    showPlanHelpModal(dirPath);
  } else if (isPlanHelpVisible()) {
    hidePlanHelpModal();
  }
}

function selectNodeById(id: string | null): void {
  planScreenState.selectedIds.clear();
  planScreenState.selectedId = id;
  planScreenState.selectedContextId = null;
  if (id === null) {
    planScreenState.editingId = null;
  }
}

function selectContextById(id: string | null): void {
  planScreenState.selectedIds.clear();
  planScreenState.selectedContextId = id;
  if (id) {
    planScreenState.selectedId = null;
  }
}

function resolvePlanTargetSessionId(item: PlanItem): string | null {
  const activeSession = state.activeSessionId
    ? state.sessions.find((session) => session.id === state.activeSessionId)
    : null;
  if (activeSession?.workingDir && pathsMatch(activeSession.workingDir, item.dirPath)) {
    return activeSession.id;
  }
  const dirSession = state.sessions.find((session) => session.workingDir && pathsMatch(session.workingDir, item.dirPath));
  return dirSession?.id ?? null;
}

function openNodeEditor(item: PlanItem): void {
  planScreenState.selectedId = item.id;
  planScreenState.editingId = item.id;
  const targetSessionId = resolvePlanTargetSessionId(item) ?? '';

  getWindowCallbacks().planEditorOpener?.(targetSessionId, item, {
    onSave: (updates) => handleSave(item.id, updates),
    onDelete: () => requestDelete(item.id),
    onDone: item.status === 'coding' || item.status === 'review'
      ? () => openNodeCompletionEditor(item)
      : undefined,
    onApply: targetSessionId && (item.status === 'ready' || item.status === 'coding' || item.status === 'review')
      ? () => handleApplyFromCanvas(item)
      : undefined,
    onClose: () => { planScreenState.editingId = null; },
  });
}

function openNodeCompletionEditor(item: PlanItem): void {
  if (item.status !== 'coding' && item.status !== 'review') {
    showBriefNotice('Only coding or review plans can be marked done');
    return;
  }
  planScreenState.selectedId = item.id;
  planScreenState.editingId = item.id;
  const targetSessionId = resolvePlanTargetSessionId(item) ?? '';
  getWindowCallbacks().planEditorOpener?.(targetSessionId, { ...item, status: 'done', stateInfo: '' }, {
    onSave: (updates) => handleSave(item.id, updates),
    onDelete: () => requestDelete(item.id),
    onApply: targetSessionId ? () => handleApplyFromCanvas(item) : undefined,
    onClose: () => { planScreenState.editingId = null; },
  });
}

function openContextNodeEditor(context: ContextNode & { sequenceIds?: string[]; planIds?: string[] }): void {
  planScreenState.selectedContextId = context.id;
  planScreenState.editingContextId = context.id;
  getWindowCallbacks().contextEditorOpener?.(context, {
    onSave: (updates) => void onPlanContextSave(context.id, updates),
    onDelete: () => void onPlanContextDelete(context.id),
    onUnbind: (targetType, targetId) => void onPlanContextUnbind(context.id, targetType, targetId),
    onClose: () => { planScreenState.editingContextId = null; },
  });
}

function requestDelete(id: string): void {
  const item = planScreenState.items.find((entry) => entry.id === id);
  if (!item) return;
  showPlanDeleteConfirm(item.title, () => {
    void handleDelete(id);
  });
}

function requestSequenceDelete(id: string, options?: { includePlans?: boolean }): void {
  const sequence = planScreenState.sequences.find((entry) => entry.id === id);
  if (!sequence) return;
  if (options?.includePlans) {
    showPlanDeleteConfirm(sequence.title, () => {
      void performSequenceDeleteWithPlans(id);
    }, {
      itemKind: 'sequence and all contained plans',
      title: 'Delete Sequence + Plans',
      message: `Delete sequence "${sequence.title}" and every plan inside it?`,
      confirmLabel: 'Delete All',
    });
    return;
  }
  showPlanDeleteConfirm(sequence.title, () => {
    void performSequenceDelete(id);
  }, {
    itemKind: 'sequence',
    title: 'Delete Sequence',
  });
}

function requestContextDelete(id: string): void {
  const context = planScreenState.contexts.find((entry) => entry.id === id);
  if (!context) return;
  showPlanDeleteConfirm(context.title, () => {
    void performContextDelete(id);
  }, {
    itemKind: 'context',
    title: 'Delete Context',
  });
}

function closePlannerOverlay(): void {
  overlayMounted = false;
  planScreenState.visible = dockPaneMounted;
  if (dockPaneMounted) return;
  planScreenState.currentDir = '';
  planScreenState.items = [];
  planScreenState.deps = [];
  planScreenState.sequences = [];
  planScreenState.contexts = [];
  planScreenState.layout = { nodes: [], width: 0, height: 0 };
  planScreenState.selectedId = null;
  planScreenState.selectedContextId = null;
  planScreenState.selectedIds.clear();
  planScreenState.editingId = null;
  planScreenState.editingContextId = null;
  planScreenState.relatedFocusRootId = null;
  planScreenState.relatedFocusIds = new Set();
  setRelatedTransientIds([]);
  hidePlanDeleteConfirm();
  hidePlanHelpModal();
  clearNotice();
}

function clearPlanDataForSession(): void {
  planScreenState.currentDir = '';
  planScreenState.items = [];
  planScreenState.deps = [];
  planScreenState.sequences = [];
  planScreenState.contexts = [];
  planScreenState.attachmentHasAny = {};
  planScreenState.layout = { nodes: [], width: 0, height: 0 };
  planScreenState.selectedId = null;
  planScreenState.selectedContextId = null;
  planScreenState.selectedIds.clear();
  planScreenState.editingId = null;
  planScreenState.editingContextId = null;
  planScreenState.relatedFocusRootId = null;
  planScreenState.relatedFocusIds = new Set();
  setRelatedTransientIds([]);
}

/**
 * Planner keys. Registered with the router at `pane` scope and claimed only
 * while the rendered canvas is focused, so inactive dock tabs never swallow keys.
 *
 * Returns whether the key was consumed; the router suppresses it.
 */
function planScreenKeyHandler(ctx: KeyContext): boolean {
  if (ctx.key === 'Escape') {
    if (isPlanHelpVisible()) {
      hidePlanHelpModal();
      return true;
    }
    if (planScreenState.editingId || planScreenState.editingContextId) {
      getWindowCallbacks().draftEditorCloser?.();
      planScreenState.selectedId = null;
      planScreenState.selectedContextId = null;
      planScreenState.editingId = null;
      planScreenState.editingContextId = null;
      return true;
    }
    if (planScreenState.selectedContextId) {
      planScreenState.selectedContextId = null;
      return true;
    }
    if (planScreenState.selectedId) {
      planScreenState.selectedId = null;
      return true;
    }
    if (planScreenState.selectedIds.size > 0) {
      planScreenState.selectedIds.clear();
      return true;
    }
    return true;
  }

  if (ctx.combo === 'ctrl+n') {
    void handleAddNode({ fromShortcut: true });
    return true;
  }

  // The draft editor is a full panel over the canvas; while it is up the
  // planner's bare-letter keys would collide with typing.
  if (getWindowCallbacks().draftEditorVisibilityChecker?.() ?? false) return false;

  if (ctx.key === 'f' || ctx.key === 'F') {
    toggleRelatedFocus();
    return true;
  }

  if (ctx.key === 'Delete' && planScreenState.selectedId) {
    requestDelete(planScreenState.selectedId);
    return true;
  }

  if (ctx.key === 'Delete' && planScreenState.selectedContextId) {
    requestContextDelete(planScreenState.selectedContextId);
    return true;
  }

  return false;
}

// A module-scope registration, so it survives re-imports without the
// `globalThis` de-duplication hack the raw listener needed.
registerKeyHandler({
  id: 'plan-screen',
  scope: 'pane',
  claims: (ctx) => planScreenState.visible && ctx.isFocused(PANE_PLAN_SCREEN),
  handle: planScreenKeyHandler,
});

export async function showPlanScreen(dirPath: string): Promise<void> {
  await showView('plan', { dir: dirPath });
}

/** Bind the singleton canvas to one directory, regardless of how it is rendered. */
export async function bindPlanScreenToDir(dirPath: string | null, context?: ViewMountContext): Promise<void> {
  if (!dirPath) {
    ++latestPlanDataLoadToken;
    clearPlanDataForSession();
    return;
  }
  if (planScreenState.currentDir && pathsMatch(planScreenState.currentDir, dirPath)) return;

  clearPlanDataForSession();
  planScreenState.currentDir = dirPath;
  planScreenState.editingId = null;
  planScreenState.editingContextId = null;
  hidePlanDeleteConfirm();
  getWindowCallbacks().draftEditorCloser?.();
  await loadPlanData(dirPath, context);
}

/** Tell the bridge whether the dock owns a rendered plan canvas. */
export function setPlanScreenPaneMounted(mounted: boolean): void {
  dockPaneMounted = mounted;
  planScreenState.visible = dockPaneMounted || overlayMounted;
  if (!mounted && !overlayMounted) {
    ++latestPlanDataLoadToken;
    closePlannerOverlay();
  }
}

async function mountPlanScreen(params?: unknown, context?: ViewMountContext): Promise<void> {
  const requestedDir = (params as { dir?: string } | undefined)?.dir ?? getActiveSessionDir() ?? '';
  overlayMounted = true;
  planScreenState.visible = true;
  hidePlanDeleteConfirm();
  getWindowCallbacks().draftEditorCloser?.();
  await loadFilterPreferences();
  await bindPlanScreenToDir(requestedDir || null, context);
  if (context && !context.isActive()) return;
}

function unmountPlanScreen(): void {
  getWindowCallbacks().draftEditorCloser?.();
  ++latestPlanDataLoadToken;
  closePlannerOverlay();
  if (fitActiveCallback) {
    requestAnimationFrame(fitActiveCallback);
  }
  closeCallback?.();
}

registerView('plan', { mount: mountPlanScreen, unmount: unmountPlanScreen });

export function hidePlanScreen(): void {
  if (currentView() === 'plan') {
    void showView('terminal');
    return;
  }
  unmountPlanScreen();
}

export function isPlanScreenVisible(): boolean {
  return planScreenState.visible;
}

export function getCurrentPlanDirPath(): string | null {
  return planScreenState.visible ? planScreenState.currentDir : null;
}

export function getSelectedPlanId(): string | null {
  return planScreenState.selectedId;
}

export function getSelectedContextId(): string | null {
  return planScreenState.selectedContextId;
}

export function handlePlanScreenDpad(dir: string): boolean {
  planScreenState.selectedIds.clear();
  const layoutNodes = getNavigableLayoutNodes();
  if (layoutNodes.length === 0) return false;

  if (!planScreenState.selectedId) {
    const first = layoutNodes.find((node) => node.layer === 0 && node.order === 0) ?? layoutNodes[0];
    planScreenState.selectedId = first.id;
    return true;
  }

  const current = layoutNodes.find((node) => node.id === planScreenState.selectedId);
  if (!current) return true;

  if (dir === 'left' || dir === 'right') {
    const targetLayer = current.layer + (dir === 'right' ? 1 : -1);
    const candidates = layoutNodes.filter((node) => node.layer === targetLayer);
    if (candidates.length === 0) return true;
    candidates.sort((a, b) => Math.abs(a.y - current.y) - Math.abs(b.y - current.y));
    planScreenState.selectedId = candidates[0].id;
    return true;
  }

  const targetOrder = current.order + (dir === 'down' ? 1 : -1);
  const target = layoutNodes.find((node) => node.layer === current.layer && node.order === targetOrder);
  if (target) {
    planScreenState.selectedId = target.id;
  }
  return true;
}

export function handlePlanScreenAction(button: string): boolean {
  if (button === 'A') {
    if (planScreenState.selectedContextId) {
      const ctx = planScreenState.contexts.find((c) => c.id === planScreenState.selectedContextId);
      if (ctx) openContextNodeEditor(ctx);
      return true;
    }
    if (planScreenState.selectedId) {
      const item = getSelectedItem();
      if (item) openNodeEditor(item);
    } else {
      const layoutNodes = getNavigableLayoutNodes();
      const first = layoutNodes.find((node) => node.layer === 0 && node.order === 0) ?? layoutNodes[0];
      if (first) planScreenState.selectedId = first.id;
    }
    return true;
  }

  if (button === 'X') {
    if (planScreenState.selectedContextId) {
      requestContextDelete(planScreenState.selectedContextId);
    } else if (planScreenState.selectedId) {
      requestDelete(planScreenState.selectedId);
    }
    return true;
  }

  if (button === 'Y') {
    void handleAddNode();
    return true;
  }

  return false;
}

async function handleSave(planId: string, updates: { title: string; description: string; status: PlanItem['status']; stateInfo?: string; type?: PlanType; autoImplement?: boolean; completionRecap?: boolean }): Promise<void> {
  const current = getPlanItemById(planId);
  if (!current) return;
  try {
    await plansClient.planUpdate(planId, { ...updates, completionRecap: updates.completionRecap });
    if (current && updates.status === 'done' && current.status !== 'done') {
      if (current.status !== 'coding' && current.status !== 'review') {
        showBriefNotice('Only coding or review plans can be marked done');
        return;
      }
      await plansClient.planComplete(planId, updates.stateInfo);
    } else if (current && updates.status !== 'done') {
      const targetSessionId = resolvePlanTargetSessionId(current);
      if (updates.status === 'coding' && !targetSessionId) {
        showBriefNotice('Select or open a session in this directory before marking a plan as coding');
        return;
      }
      await plansClient.planSetState(planId, updates.status, updates.stateInfo);
    }
    await refreshCanvas();
  } catch (err) {
    console.error('[PlanScreen] Save failed:', err);
  }
}

async function handleDelete(id: string): Promise<void> {
  try {
    await plansClient.planDelete(id);
    planScreenState.selectedId = null;
    planScreenState.editingId = null;
    getWindowCallbacks().draftEditorCloser?.();
    await refreshCanvas();
  } catch (err) {
    console.error('[PlanScreen] Delete failed:', err);
  }
}

async function handleApplyFromCanvas(item: PlanItem): Promise<void> {
  try {
    const targetSessionId = resolvePlanTargetSessionId(item);
    if (!targetSessionId) {
      showBriefNotice('Open a session in this directory before applying a plan');
      return;
    }

    const result = await dialogClient.writeTempContent(item.description);
    if (!result?.success || !result.path) {
      console.error('[PlanScreen] Failed to write temp file:', result?.error);
      return;
    }

    await deliverPromptSequence(targetSessionId, `work for you to do is here: ${result.path}{Send}`);
    if (item.status === 'ready') {
      await plansClient.planApply(item.id);
    }

    planScreenState.selectedId = null;
    planScreenState.editingId = null;
    hidePlanDeleteConfirm();
    getWindowCallbacks().draftEditorCloser?.();
    await refreshCanvas();
  } catch (err) {
    console.error('[PlanScreen] Apply failed:', err);
  }
}

async function handleAddNode(options?: { fromShortcut?: boolean; kind?: 'plan' | 'context' }): Promise<void> {
  if (planScreenState.editingId && options?.fromShortcut) {
    showBriefNotice('Finish or cancel current edits before creating a new plan');
    return;
  }

  try {
    if (options?.kind === 'context') {
      const created = await contextsClient.planContextCreate?.(planScreenState.currentDir, {
        title: 'New Context',
        type: 'Knowledge',
        permission: 'readonly',
        content: '',
        x: null,
        y: null,
      });
      const createdId = created && typeof created === 'object' && 'id' in created ? String(created.id) : null;
      await refreshCanvas({ preserveTransientFocus: true });
      if (createdId) {
        selectContextById(createdId);
        const createdCtx = planScreenState.contexts.find((c) => c.id === createdId);
        if (createdCtx) openContextNodeEditor(createdCtx);
      }
      return;
    }

    const created = await plansClient.planCreate(planScreenState.currentDir, 'New Plan', '');
    const createdId = created && typeof created === 'object' && 'id' in created ? String(created.id) : null;
    if (createdId && planScreenState.relatedFocusRootId) {
      setRelatedTransientIds([...planScreenState.relatedTransientIds, createdId]);
    }
    if (planScreenState.editingId) {
      getWindowCallbacks().draftEditorCloser?.();
      planScreenState.editingId = null;
    }

    await refreshCanvas({ preserveTransientFocus: true });

    const createdItem = createdId ? planScreenState.items.find((item) => item.id === createdId) ?? null : null;
    if (createdItem) {
      openNodeEditor(createdItem);
    }
  } catch (err) {
    console.error('[PlanScreen] Add failed:', err);
  }
}

async function handleRemoveDep(dep: PlanDependency): Promise<void> {
  try {
    await plansClient.planRemoveDep(dep.fromId, dep.toId);
    await refreshCanvas();
  } catch (err) {
    console.error('[PlanScreen] Remove dep failed:', err);
  }
}

async function handleAddDep(fromId: string, toId: string): Promise<void> {
  try {
    await plansClient.planAddDep(fromId, toId);
    await refreshCanvas({ preserveTransientFocus: true });
  } catch (err) {
    console.error('[PlanScreen] Add dep failed:', err);
    showBriefNotice('Could not add dependency');
  }
}

async function refreshCanvas(options?: RefreshCanvasOptions): Promise<void> {
  if (!planScreenState.currentDir) return;
  await loadPlanData(planScreenState.currentDir, undefined, options);
}

export async function refreshCanvasIfVisible(): Promise<void> {
  if (isPlanScreenVisible()) await refreshCanvas();
}

async function handleExportDirectory(): Promise<void> {
  try {
    const json = await incomingClient.planExportDirectory(planScreenState.currentDir);
    if (!json) return;
    const folderName = planScreenState.currentDir.split(/[/\\]/).filter(Boolean).pop() ?? 'plans';
    const savePath = await dialogClient.dialogShowSaveFile(`${folderName}-plans.json`);
    if (!savePath) return;
    const ok = await incomingClient.planWriteFile(savePath, json);
    if (ok) showBriefNotice('Plans exported ✓');
  } catch (err) {
    console.error('[PlanScreen] Export directory failed:', err);
  }
}

/** The Plans screen's bulk cleanups. "unused" is empty sequences, then unreferenced contexts. */
export type PlanCleanupKind = 'unused' | 'done' | 'sequences' | 'contexts';

const CLEANUP_TITLES: Record<PlanCleanupKind, string> = {
  unused: 'Clear unused items?',
  done: 'Clear done plans?',
  sequences: 'Clear empty sequences?',
  contexts: 'Clear unreferenced contexts?',
};

async function handleCleanup(kind: PlanCleanupKind): Promise<void> {
  const dirPath = planScreenState.currentDir;
  try {
    const counts = await plansClient.planCleanupCounts(dirPath);
    const sequences = { count: counts.emptySequences, noun: 'empty sequence' };
    const lines = {
      done: [{ count: counts.donePlans, noun: 'completed plan' }],
      sequences: [sequences],
      contexts: [{ count: counts.unreferencedContexts, noun: 'unreferenced context' }],
      // Clearing the sequences first frees contexts bound only to them.
      unused: [sequences, { count: counts.unusedContexts, noun: 'unreferenced context' }],
    }[kind].filter((line) => line.count > 0);
    if (lines.length === 0) {
      showBriefNotice('Nothing to clear');
      return;
    }
    const parts = dirPath.replace(/\\/g, '/').split('/');
    bulkCleanup.title = CLEANUP_TITLES[kind];
    bulkCleanup.lines = lines;
    bulkCleanup.dirName = parts[parts.length - 1] || dirPath;
    bulkCleanup.visible = true;
    setBulkCleanupCallback(async () => {
      if (kind === 'done') await plansClient.planClearCompleted(dirPath);
      if (kind === 'sequences' || kind === 'unused') await plansClient.planClearEmptySequences(dirPath);
      if (kind === 'contexts' || kind === 'unused') await plansClient.planClearUnreferencedContexts(dirPath);
      await refreshCanvas();
    });
  } catch (err) {
    console.error('[PlanScreen] Cleanup failed:', err);
  }
}

export function onPlanNodeClick(id: string, event?: MouseEvent): void {
  if (event?.ctrlKey || event?.metaKey) {
    if (planScreenState.selectedIds.has(id)) {
      planScreenState.selectedIds.delete(id);
    } else {
      planScreenState.selectedIds.add(id);
    }
    planScreenState.selectedId = id;
    return;
  }
  planScreenState.selectedIds.clear();
  if (planScreenState.selectedId === id) {
    const item = planScreenState.items.find((entry) => entry.id === id);
    if (item) openNodeEditor(item);
    return;
  }
  selectNodeById(id);
}

export function onPlanNodeEdit(id: string): void {
  const item = planScreenState.items.find((entry) => entry.id === id);
  if (item) openNodeEditor(item);
}

export function onPlanNodeApply(id: string): void {
  const item = planScreenState.items.find((entry) => entry.id === id);
  if (item) void handleApplyFromCanvas(item);
}

export function onPlanNodeDelete(id: string): void {
  requestDelete(id);
}

export function onPlanNodeComplete(id: string): void {
  const item = planScreenState.items.find((entry) => entry.id === id);
  if (item) openNodeCompletionEditor(item);
}

export function onPlanAddNode(): Promise<void> {
  return handleAddNode();
}

export function onPlanAddContext(): Promise<void> {
  return handleAddNode({ kind: 'context' });
}

export function onPlanAddDependency(fromId: string, toId: string): Promise<void> {
  return handleAddDep(fromId, toId);
}

export function onPlanRemoveDependency(fromId: string, toId: string): void {
  void handleRemoveDep({ fromId, toId });
}

export function onPlanExportDirectory(): void {
  void handleExportDirectory();
}

async function handleOpenPlanExternal(): Promise<void> {
  const selected = getSelectedItem();
  if (!selected) {
    showBriefNotice('Select a plan first');
    return;
  }
  try {
    const result = await plansClient.planOpenExternal?.(selected.id);
    if (!result?.success) {
      showBriefNotice(result?.error ?? 'Could not open plan externally');
    }
  } catch (err) {
    console.error('[PlanScreen] Open plan external failed:', err);
    showBriefNotice('Could not open plan externally');
  }
}

export function onPlanOpenExternal(): void {
  void handleOpenPlanExternal();
}

export function onPlanCleanup(kind: PlanCleanupKind): void {
  void handleCleanup(kind);
}

export async function onPlanCreateSequence(title: string, missionStatement: string, sharedMemory: string): Promise<void> {
  const selected = getSelectedItem();
  if (!selected) return;
  const sequence = await plansClient.planSequenceCreate?.(
    planScreenState.currentDir,
    title || 'New Sequence',
    missionStatement,
    sharedMemory,
  );
  if (sequence?.id) {
    await plansClient.planSequenceAssign?.(selected.id, sequence.id);
    await refreshCanvas();
  }
}

export async function onPlanAssignSequence(planId: string, sequenceId: string | null): Promise<void> {
  await plansClient.planSequenceAssign?.(planId, sequenceId);
  await refreshCanvas();
}

export async function onPlanUpdateSequence(
  id: string,
  updates: { title?: string; missionStatement?: string; sharedMemory?: string; order?: number },
): Promise<void> {
  await plansClient.planSequenceUpdate?.(id, updates);
  await refreshCanvas();
}

export async function onPlanDeleteSequence(id: string): Promise<void> {
  requestSequenceDelete(id);
}

async function performSequenceDelete(id: string): Promise<void> {
  await plansClient.planSequenceDelete?.(id);
  await refreshCanvas();
}

export async function onPlanDeleteSequenceWithPlans(id: string): Promise<void> {
  requestSequenceDelete(id, { includePlans: true });
}

async function performSequenceDeleteWithPlans(id: string): Promise<void> {
  await plansClient.planSequenceDeleteWithPlans?.(id);
  await refreshCanvas();
}

export function onPlanContextClick(id: string): void {
  selectContextById(id);
}

export function onPlanContextEdit(id: string): void {
  const context = planScreenState.contexts.find((c) => c.id === id);
  if (!context) return;
  openContextNodeEditor(context);
}

export async function onPlanContextMove(id: string, x: number | null, y: number | null): Promise<void> {
  await contextsClient.planContextSetPosition?.(id, x, y);
  await refreshCanvas();
}

export async function onPlanContextBind(id: string, sequenceId: string): Promise<void> {
  await contextsClient.planContextBind?.(id, 'sequence', sequenceId);
  await refreshCanvas();
}

export async function onPlanContextBindTarget(id: string, targetType: ContextBindingTargetType, targetId: string): Promise<void> {
  await contextsClient.planContextBind?.(id, targetType, targetId);
  await refreshCanvas();
}

export async function onPlanContextUnbind(id: string, targetType: ContextBindingTargetType, targetId: string): Promise<void> {
  await contextsClient.planContextUnbind?.(id, targetType, targetId);
  await refreshCanvas();
}

export function onPlanContextSelectPlan(planId: string): void {
  selectNodeById(planId);
}

export async function onPlanContextSave(
  id: string,
  updates: { title?: string; type?: string; permission?: 'readonly' | 'writable'; content?: string },
  pendingUnbinds: Array<{ targetType: ContextBindingTargetType; targetId: string }> = [],
): Promise<void> {
  await contextsClient.planContextUpdate?.(id, updates);
  for (const entry of pendingUnbinds) {
    await contextsClient.planContextUnbind?.(id, entry.targetType, entry.targetId);
  }
  await refreshCanvas();
  selectContextById(id);
}

export async function onPlanContextDelete(id: string): Promise<void> {
  requestContextDelete(id);
}

async function performContextDelete(id: string): Promise<void> {
  const deleted = await contextsClient.planContextDelete?.(id);
  if (!deleted) {
    showBriefNotice('Could not delete context');
    return;
  }
  if (planScreenState.selectedContextId === id) {
    planScreenState.selectedContextId = null;
  }
  await refreshCanvas();
}

export function toggleRelatedFocus(): void {
  if (planScreenState.relatedFocusRootId) {
    planScreenState.relatedFocusRootId = null;
    planScreenState.relatedFocusIds = new Set();
    setRelatedTransientIds([]);
    return;
  }

  const rootId = planScreenState.selectedId;
  if (!rootId || !planScreenState.items.some((item) => item.id === rootId)) return;
  planScreenState.relatedFocusRootId = rootId;
  refreshRelatedFocus();
}

export function toggleTypeFilter(type: 'bug' | 'feature' | 'research' | 'untyped'): void {
  planScreenState.filters.types[type] = cycleTriState(planScreenState.filters.types[type]);
  refreshLayout();
  void saveFilterPreferences();
}

export function toggleStatusFilter(status: 'planning' | 'ready' | 'coding' | 'review' | 'blocked' | 'done'): void {
  planScreenState.filters.statuses[status] = cycleTriState(planScreenState.filters.statuses[status]);
  refreshLayout();
  void saveFilterPreferences();
}

export function toggleStatusGroup(group: 'active' | 'terminal' | 'planning'): void {
  const groups = {
    active: ['coding', 'review', 'blocked'],
    terminal: ['done'],
    planning: ['planning', 'ready'],
  };
  const statuses = groups[group] ?? [];
  const currentValues = statuses.map(s => planScreenState.filters.statuses[s]);
  const allYes = currentValues.every(v => v === 'yes');
  const newValue: TriState = allYes ? 'either' : 'yes';
  for (const status of statuses) {
    planScreenState.filters.statuses[status] = newValue;
  }
  refreshLayout();
  void saveFilterPreferences();
}

export function resetFilters(): void {
  planScreenState.filters = makeDefaultFilters();
  refreshLayout();
  void saveFilterPreferences();
}

export function toggleHasAttachmentFilter(value: 'yes' | 'no'): void {
  planScreenState.filters.hasAttachment[value] = cycleTriState(planScreenState.filters.hasAttachment[value]);
  refreshLayout();
  void saveFilterPreferences();
}

export function toggleAutoFilter(): void {
  planScreenState.filters.auto = cycleTriState(planScreenState.filters.auto);
  refreshLayout();
  void saveFilterPreferences();
}

function refreshLayout(): void {
  const filteredItems = getFilteredItems();
  const filteredDeps = getFilteredDeps(planScreenState.deps);
  planScreenState.layout = computeLayout(filteredItems, filteredDeps);
  syncSelection();
}

