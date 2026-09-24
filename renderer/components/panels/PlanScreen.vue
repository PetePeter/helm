<script setup lang="ts">
import { computed, reactive, ref, watch, onUnmounted } from 'vue';
import { getDisplayTitle } from '../../types.js';
import { formatDate } from '../../utils/date-format.js';
import type { PlanDependency, PlanItem, PlanSequence } from '../../../src/types/plan.js';
import type { ContextBindingTargetType, ContextNode } from '../../../src/types/context.js';
import type { LayoutResult } from '../../plans/plan-layout.js';
import type { TriState } from '../../plans/plan-screen.js';
import PanelHeader from '../common/PanelHeader.vue';
import FilterChip from '../common/FilterChip.vue';
import SplitActionButton from '../buttons/SplitActionButton.vue';
import type { PlanCleanupKind } from '../../plans/plan-screen.js';
import SequencePanel from './SequencePanel.vue';
import { isEditableElement } from '../../input/input-ownership.js';
import { getPlanStatusColor } from '../../state-colors.js';

const NODE_W = 200;
const NODE_H = 102;
const CONNECTOR_R = 6;
const CONNECTOR_SNAP_TOLERANCE_PX = 16;
const EMPTY_SEQ_W = 260;
const EMPTY_SEQ_H = 80;
const CONTEXT_W = 230;
const CONTEXT_H = 130;

function filterState(value: unknown): TriState {
  if (value === true || value === 'yes') return 'yes';
  if (value === false || value === 'no') return 'no';
  return 'either';
}

const props = withDefaults(defineProps<{
  visible: boolean;
  dirPath: string;
  items: PlanItem[];
  deps: PlanDependency[];
  sequences?: PlanSequence[];
  contexts?: Array<ContextNode & { sequenceIds?: string[]; planIds?: string[] }>;
  layout: LayoutResult;
  selectedId: string | null;
  selectedContextId?: string | null;
  selectedIds?: Set<string>;
  notice?: string;
  relatedFocusRootId?: string | null;
  relatedFocusIds?: Set<string>;
  relatedTransientIds?: Set<string>;
  filters?: {
    types: { bug: TriState; feature: TriState; research: TriState; untyped: TriState };
    statuses: { planning: TriState; ready: TriState; coding: TriState; review: TriState; blocked: TriState; done: TriState };
    hasAttachment?: { yes: TriState; no: TriState };
    auto: TriState;
  };
  attachmentHasAny?: Record<string, boolean>;
  canPopOut?: boolean;
}>(), {
  sequences: () => [],
  contexts: () => [],
  selectedContextId: null,
  selectedIds: () => new Set<string>(),
  relatedFocusRootId: null,
  relatedFocusIds: () => new Set<string>(),
  relatedTransientIds: () => new Set<string>(),
  filters: () => ({
    types: { bug: 'either', feature: 'either', research: 'either', untyped: 'either' },
    statuses: { planning: 'either', ready: 'either', coding: 'either', review: 'either', blocked: 'either', done: 'either' },
    hasAttachment: { yes: 'either', no: 'either' },
    auto: 'either',
  }),
  canPopOut: true,
});

const emit = defineEmits<{
  close: [];
  addNode: [];
  addContext: [];
  exportDir: [];
  openPlanExternal: [];
  cleanup: [kind: PlanCleanupKind];
  popOut: [];
  createSequence: [title: string, missionStatement: string, sharedMemory: string];
  assignSequence: [planId: string, sequenceId: string | null];
  updateSequence: [id: string, updates: { title?: string; missionStatement?: string; sharedMemory?: string; order?: number }];
  deleteSequence: [id: string];
  deleteSequenceWithPlans: [id: string];
  nodeClick: [id: string, event?: MouseEvent];
  contextClick: [id: string];
  contextMove: [id: string, x: number | null, y: number | null];
  contextBind: [id: string, sequenceId: string];
  contextBindTarget: [id: string, targetType: ContextBindingTargetType, targetId: string];
  contextUnbind: [id: string, targetType: ContextBindingTargetType, targetId: string];
  contextSelectPlan: [planId: string];
  contextDelete: [id: string];
  contextEdit: [id: string];
  editNode: [id: string];
  applyNode: [id: string];
  completeNode: [id: string];
  deleteNode: [id: string];
  addDep: [fromId: string, toId: string];
  removeDep: [fromId: string, toId: string];
  toggleRelatedFocus: [];
  toggleTypeFilter: [type: 'bug' | 'feature' | 'research' | 'untyped'];
  toggleStatusFilter: [status: 'planning' | 'ready' | 'coding' | 'review' | 'blocked' | 'done'];
  toggleHasAttachmentFilter: [value: 'yes' | 'no'];
  toggleAutoFilter: [];
  resetFilters: [];
}>();

const wrapperRef = ref<HTMLElement | null>(null);
const svgRef = ref<SVGSVGElement | null>(null);
const seqPanelRef = ref<InstanceType<typeof SequencePanel> | null>(null);
const viewBox = ref({ x: 0, y: 0, w: 800, h: 600 });
const isPanning = ref(false);
const panStart = ref({ x: 0, y: 0, vbx: 0, vby: 0 });

// ── Viewport persistence (zoom/pan per directory) ────────────────────────────

interface SavedViewport {
  zoomScale: number;
  panFracX: number;
  panFracY: number;
}

function viewportKey(dirPath: string): string {
  return `plan-viewport:${btoa(dirPath)}`;
}

function savePlanViewport(dirPath: string): void {
  if (!dirPath || !canvasBounds.value.width) return;
  const cw = canvasBounds.value.width;
  const ch = canvasBounds.value.height;
  const vb = viewBox.value;
  try {
    const entry: SavedViewport = {
      zoomScale: cw / (vb.w || cw),
      panFracX: vb.x / cw,
      panFracY: vb.y / ch,
    };
    localStorage.setItem(viewportKey(dirPath), JSON.stringify(entry));
  } catch { /* quota exceeded — ignore */ }
}

function loadPlanViewport(dirPath: string): SavedViewport | null {
  if (!dirPath) return null;
  try {
    const raw = localStorage.getItem(viewportKey(dirPath));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

let viewportSaveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleViewportSave(): void {
  if (viewportSaveTimer) clearTimeout(viewportSaveTimer);
  viewportSaveTimer = setTimeout(() => {
    viewportSaveTimer = null;
    savePlanViewport(props.dirPath);
  }, 300);
}
const dragState = ref<{ fromId: string; x: number; y: number } | null>(null);
const seqDragState = ref<{ ids: string[]; x: number; y: number; hoveredSeqId: string | null } | null>(null);
const contextDragState = ref<{
  id: string;
  x: number;
  y: number;
  hoveredSeqId: string | null;
  hoveredPlanId: string | null;
  offsetX: number;
  offsetY: number;
  startX: number;
  startY: number;
  moved: boolean;
} | null>(null);
const contextLinkState = ref<{
  id: string;
  x: number;
  y: number;
  hoveredSeqId: string | null;
  hoveredPlanId: string | null;
} | null>(null);


const nodeMap = computed(() => {
  const map = new Map<string, LayoutResult['nodes'][number]>();
  for (const node of props.layout.nodes) map.set(node.id, node);
  return map;
});

const positionedItems = computed(() =>
  props.items
    .map((item) => {
      const layoutNode = nodeMap.value.get(item.id);
      return layoutNode ? { ...item, ...layoutNode } : null;
    })
    .filter((item): item is NonNullable<typeof item> => item !== null),
);

const selectedItem = computed(() =>
  props.selectedId ? props.items.find((item) => item.id === props.selectedId) ?? null : null,
);

const positionedContexts = computed(() =>
  (props.contexts ?? []).map((context, index) => ({
    ...context,
    x: context.x ?? 40 + (index % 3) * (CONTEXT_W + 24),
    y: context.y ?? Math.max(props.layout.height, 600) + 120 + Math.floor(index / 3) * (CONTEXT_H + 20),
  })),
);

const contextCountByPlanId = computed(() => {
  const counts = new Map<string, number>();
  for (const ctx of props.contexts) {
    for (const planId of (ctx.planIds ?? [])) {
      counts.set(planId, (counts.get(planId) ?? 0) + 1);
    }
  }
  return counts;
});

const contextsBySequenceId = computed(() => {
  const map = new Map<string, Array<ContextNode & { sequenceIds?: string[]; planIds?: string[] }>>();
  for (const context of props.contexts) {
    for (const sequenceId of (context.sequenceIds ?? [])) {
      const existing = map.get(sequenceId) ?? [];
      existing.push(context);
      map.set(sequenceId, existing);
    }
  }
  return map;
});

const sequenceBoxes = computed(() => {
  const populated: { sequence: PlanSequence; x: number; y: number; width: number; height: number; isEmpty: false }[] = [];
  const empty: { sequence: PlanSequence; x: number; y: number; width: number; height: number; isEmpty: true }[] = [];

  for (const sequence of props.sequences) {
    const nodes = positionedItems.value.filter((item) => item.sequenceId === sequence.id);
    if (nodes.length > 0) {
      const minX = Math.min(...nodes.map((node) => node.x)) - 30;
      const minY = Math.min(...nodes.map((node) => node.y)) - 42;
      const maxX = Math.max(...nodes.map((node) => node.x + NODE_W)) + 30;
      const maxY = Math.max(...nodes.map((node) => node.y + NODE_H)) + 26;
      populated.push({ sequence, x: minX, y: minY, width: maxX - minX, height: maxY - minY, isEmpty: false });
    } else {
      empty.push({ sequence, x: 0, y: 0, width: EMPTY_SEQ_W, height: EMPTY_SEQ_H, isEmpty: true });
    }
  }

  const emptyRowY = Math.max(props.layout.height, 600) + 80;
  const emptyCols = Math.max(1, Math.floor((Math.max(props.layout.width, 800) - 40) / (EMPTY_SEQ_W + 20)));
  for (let i = 0; i < empty.length; i++) {
    empty[i]!.x = 20 + (i % emptyCols) * (EMPTY_SEQ_W + 20);
    empty[i]!.y = emptyRowY + Math.floor(i / emptyCols) * (EMPTY_SEQ_H + 16);
  }

  return [...populated, ...empty] as Array<{ sequence: PlanSequence; x: number; y: number; width: number; height: number; isEmpty: boolean }>;
});

const canvasBounds = computed(() => {
  let width = Math.max(props.layout.width, 800);
  let height = Math.max(props.layout.height, 600);
  for (const box of sequenceBoxes.value) {
    width = Math.max(width, box.x + box.width + 40);
    height = Math.max(height, box.y + box.height + 40);
  }
  for (const context of positionedContexts.value) {
    width = Math.max(width, context.x + CONTEXT_W + 40);
    height = Math.max(height, context.y + CONTEXT_H + 40);
  }
  return { width, height };
});

const unlinkedZone = computed(() => {
  const hasSequences = props.sequences.length > 0;
  const unlinkedNodes = positionedItems.value.filter(i => !i.sequenceId);
  if (!hasSequences || unlinkedNodes.length === 0) return null;
  const minX = Math.min(...unlinkedNodes.map(n => n.x));
  const minY = Math.min(...unlinkedNodes.map(n => n.y));
  return { x: minX, y: minY - 30 };
});

const relatedFocusActive = computed(() => !!props.relatedFocusRootId);

const relatedForegroundIds = computed(() => {
  const ids = new Set(props.relatedFocusIds ?? []);
  for (const id of props.relatedTransientIds ?? []) ids.add(id);
  return ids;
});

const dragPath = computed(() => {
  if (!dragState.value) return '';
  const from = nodeMap.value.get(dragState.value.fromId);
  if (!from) return '';
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = dragState.value.x;
  const y2 = dragState.value.y;
  return `M ${x1} ${y1} L ${x2} ${y2}`;
});

const contextLinkPath = computed(() => {
  if (!contextLinkState.value) return '';
  const context = positionedContexts.value.find((entry) => entry.id === contextLinkState.value?.id);
  if (!context) return '';
  const x1 = context.x + CONTEXT_W;
  const y1 = context.y + CONTEXT_H / 2;
  return `M ${x1} ${y1} L ${contextLinkState.value.x} ${contextLinkState.value.y}`;
});

watch(() => [props.visible, canvasBounds.value.width, canvasBounds.value.height], () => {
  if (!props.visible) return;
  const cw = canvasBounds.value.width;
  const ch = canvasBounds.value.height;
  const saved = loadPlanViewport(props.dirPath);
  if (saved && saved.zoomScale > 0) {
    const restoredW = cw / saved.zoomScale;
    const restoredH = ch / saved.zoomScale;
    const restoredX = saved.panFracX * cw;
    const restoredY = saved.panFracY * ch;
    // Fall back to content-fit if restored viewport is entirely outside content
    if (restoredX + restoredW > 0 && restoredY + restoredH > 0 &&
        restoredX < cw && restoredY < ch) {
      viewBox.value = { x: restoredX, y: restoredY, w: restoredW, h: restoredH };
      return;
    }
  }
  viewBox.value = { x: 0, y: 0, w: cw, h: ch };
}, { immediate: true });

watch([() => viewBox.value.x, () => viewBox.value.y, () => viewBox.value.w, () => viewBox.value.h], () => {
  if (props.visible && !isPanning.value) scheduleViewportSave();
});
watch(isPanning, (panning) => {
  if (!panning && props.visible) savePlanViewport(props.dirPath);
});

function getNodeColor(status: string): string {
  return getPlanStatusColor(status);
}

function connectorPoint(id: string, side: 'in' | 'out'): { x: number; y: number } | null {
  const node = nodeMap.value.get(id);
  if (!node) return null;
  return {
    x: side === 'out' ? node.x + NODE_W : node.x,
    y: node.y + NODE_H / 2,
  };
}

function depPath(dep: PlanDependency): string {
  const from = connectorPoint(dep.fromId, 'out');
  const to = connectorPoint(dep.toId, 'in');
  if (!from || !to) return '';
  const cpx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  return `M ${from.x} ${from.y} Q ${cpx} ${from.y}, ${cpx} ${my} Q ${cpx} ${to.y}, ${to.x} ${to.y}`;
}

function isRelatedBackground(id: string): boolean {
  return relatedFocusActive.value && !relatedForegroundIds.value.has(id);
}

function isDepRelatedBackground(dep: PlanDependency): boolean {
  return isRelatedBackground(dep.fromId) || isRelatedBackground(dep.toId);
}

function wrapperPoint(clientX: number, clientY: number): { x: number; y: number } {
  const rect = wrapperRef.value?.getBoundingClientRect();
  if (!rect) return { x: clientX, y: clientY };
  return {
    x: ((clientX - rect.left) / (rect.width || 1)) * viewBox.value.w + viewBox.value.x,
    y: ((clientY - rect.top) / (rect.height || 1)) * viewBox.value.h + viewBox.value.y,
  };
}

function applyMatrix(matrix: DOMMatrix, x: number, y: number): { x: number; y: number } {
  return {
    x: matrix.a * x + matrix.c * y + matrix.e,
    y: matrix.b * x + matrix.d * y + matrix.f,
  };
}

function svgPoint(clientX: number, clientY: number): { x: number; y: number } {
  const svg = svgRef.value;
  const matrix = svg && typeof svg.getScreenCTM === 'function' ? svg.getScreenCTM() : null;
  const inverse = matrix?.inverse?.() ?? null;
  return inverse ? applyMatrix(inverse, clientX, clientY) : wrapperPoint(clientX, clientY);
}

function connectorClientPoint(x: number, y: number): { x: number; y: number } {
  const svg = svgRef.value;
  const matrix = svg && typeof svg.getScreenCTM === 'function' ? svg.getScreenCTM() : null;
  if (matrix) return applyMatrix(matrix, x, y);
  const rect = wrapperRef.value?.getBoundingClientRect();
  if (!rect) return { x, y };
  return {
    x: ((x - viewBox.value.x) / viewBox.value.w) * (rect.width || 1) + rect.left,
    y: ((y - viewBox.value.y) / viewBox.value.h) * (rect.height || 1) + rect.top,
  };
}

function findSnapTarget(clientX: number, clientY: number, fromId: string): string | null {
  let best: { id: string; distance: number } | null = null;
  for (const node of props.layout.nodes) {
    if (node.id === fromId) continue;
    const point = connectorClientPoint(node.x, node.y + NODE_H / 2);
    const distance = Math.hypot(clientX - point.x, clientY - point.y);
    if (distance > CONNECTOR_SNAP_TOLERANCE_PX) continue;
    if (!best || distance < best.distance) {
      best = { id: node.id, distance };
    }
  }
  return best?.id ?? null;
}

function onCanvasMouseDown(e: MouseEvent): void {
  const target = e.target as Element;
  if (target.closest('.plan-node') || target.closest('.plan-arrow')) return;
  isPanning.value = true;
  panStart.value = {
    x: e.clientX,
    y: e.clientY,
    vbx: viewBox.value.x,
    vby: viewBox.value.y,
  };
}

function onCanvasMouseMove(e: MouseEvent): void {
  if (dragState.value) {
    dragState.value = {
      ...dragState.value,
      ...svgPoint(e.clientX, e.clientY),
    };
    return;
  }
  if (contextDragState.value) {
    const pt = svgPoint(e.clientX, e.clientY);
    const moved = contextDragState.value.moved
      || Math.hypot(pt.x - contextDragState.value.startX, pt.y - contextDragState.value.startY) > 3;
    contextDragState.value = {
      ...contextDragState.value,
      x: pt.x - contextDragState.value.offsetX,
      y: pt.y - contextDragState.value.offsetY,
      moved,
    };
    return;
  }
  if (contextLinkState.value) {
    const pt = svgPoint(e.clientX, e.clientY);
    contextLinkState.value = {
      ...contextLinkState.value,
      x: pt.x,
      y: pt.y,
      hoveredSeqId: findSeqBoxAtPoint(pt.x, pt.y),
      hoveredPlanId: findPlanAtPoint(pt.x, pt.y),
    };
    return;
  }
  if (seqDragState.value) {
    const pt = svgPoint(e.clientX, e.clientY);
    seqDragState.value = {
      ...seqDragState.value,
      x: pt.x,
      y: pt.y,
      hoveredSeqId: findSeqBoxAtPoint(pt.x, pt.y),
    };
    return;
  }
  if (!isPanning.value || !wrapperRef.value) return;
  const rect = wrapperRef.value.getBoundingClientRect();
  const sx = viewBox.value.w / (rect.width || 1);
  const sy = viewBox.value.h / (rect.height || 1);
  viewBox.value = {
    ...viewBox.value,
    x: panStart.value.vbx - (e.clientX - panStart.value.x) * sx,
    y: panStart.value.vby - (e.clientY - panStart.value.y) * sy,
  };
}

function onCanvasMouseUp(e: MouseEvent): void {
  if (dragState.value) {
    const targetId = findSnapTarget(e.clientX, e.clientY, dragState.value.fromId);
    if (targetId && targetId !== dragState.value.fromId) {
      emit('addDep', dragState.value.fromId, targetId);
    }
    dragState.value = null;
  }
  if (seqDragState.value) {
    if (seqDragState.value.hoveredSeqId) {
      for (const id of seqDragState.value.ids) {
        emit('assignSequence', id, seqDragState.value.hoveredSeqId);
      }
    }
    seqDragState.value = null;
  }
  if (contextDragState.value) {
    if (contextDragState.value.moved) {
      emit('contextMove', contextDragState.value.id, contextDragState.value.x, contextDragState.value.y);
    }
    contextDragState.value = null;
  }
  if (contextLinkState.value) {
    if (contextLinkState.value.hoveredPlanId) {
      emit('contextBindTarget', contextLinkState.value.id, 'plan', contextLinkState.value.hoveredPlanId);
    } else if (contextLinkState.value.hoveredSeqId) {
      emit('contextBind', contextLinkState.value.id, contextLinkState.value.hoveredSeqId);
    }
    contextLinkState.value = null;
  }
  isPanning.value = false;
}

function onCanvasWheel(e: WheelEvent): void {
  e.preventDefault();
  if (!wrapperRef.value) return;
  const rect = wrapperRef.value.getBoundingClientRect();
  const scale = e.deltaY > 0 ? 1.1 : 0.9;
  const mx = ((e.clientX - rect.left) / (rect.width || 1)) * viewBox.value.w + viewBox.value.x;
  const my = ((e.clientY - rect.top) / (rect.height || 1)) * viewBox.value.h + viewBox.value.y;
  viewBox.value = {
    w: viewBox.value.w * scale,
    h: viewBox.value.h * scale,
    x: mx - ((e.clientX - rect.left) / (rect.width || 1)) * viewBox.value.w * scale,
    y: my - ((e.clientY - rect.top) / (rect.height || 1)) * viewBox.value.h * scale,
  };
}

function startDragConnection(id: string, e: MouseEvent): void {
  e.stopPropagation();
  dragState.value = {
    fromId: id,
    ...svgPoint(e.clientX, e.clientY),
  };
}

function onNodeBodyMouseDown(id: string, e: MouseEvent): void {
  if ((e.target as Element).closest('.plan-node__connector')) return;
  e.stopPropagation();
  focusPlanScreen();
  const ids = props.selectedIds.has(id) ? [...props.selectedIds] : [id];
  const pt = svgPoint(e.clientX, e.clientY);
  seqDragState.value = { ids, x: pt.x, y: pt.y, hoveredSeqId: null };
}

function onContextMouseDown(id: string, e: MouseEvent): void {
  if ((e.target as Element).closest('.plan-context-card__connector')) return;
  e.stopPropagation();
  focusPlanScreen();
  emit('contextClick', id);
  const pt = svgPoint(e.clientX, e.clientY);
  const context = positionedContexts.value.find((entry) => entry.id === id);
  if (!context) return;
  contextDragState.value = {
    id,
    x: context.x,
    y: context.y,
    hoveredSeqId: null,
    hoveredPlanId: null,
    offsetX: pt.x - context.x,
    offsetY: pt.y - context.y,
    startX: pt.x,
    startY: pt.y,
    moved: false,
  };
}

function startContextLink(id: string, e: MouseEvent): void {
  e.stopPropagation();
  focusPlanScreen();
  emit('contextClick', id);
  contextLinkState.value = {
    id,
    ...svgPoint(e.clientX, e.clientY),
    hoveredSeqId: null,
    hoveredPlanId: null,
  };
}

function findSeqBoxAtPoint(x: number, y: number): string | null {
  for (const box of sequenceBoxes.value) {
    if (x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height) {
      return box.sequence.id;
    }
  }
  return null;
}

function findPlanAtPoint(x: number, y: number): string | null {
  for (const item of positionedItems.value) {
    if (x >= item.x && x <= item.x + NODE_W && y >= item.y && y <= item.y + NODE_H) {
      return item.id;
    }
  }
  return null;
}

function unlinkFromSequence(id: string, e: MouseEvent): void {
  e.stopPropagation();
  emit('assignSequence', id, null);
}

const ADD_ITEMS = [
  { value: 'plan', label: 'Add Plan' },
  { value: 'context', label: 'Add Context' },
  { value: 'sequence', label: 'Add Sequence' },
] as const satisfies readonly { value: string; label: string }[];

const CLEANUP_ITEMS = [
  { value: 'done', label: 'Clear done plans', detail: 'Completed plan items only' },
  { value: 'sequences', label: 'Clear empty sequences', detail: 'Sequences with no member plans' },
  { value: 'contexts', label: 'Clear unreferenced contexts', detail: 'Contexts with no plan or sequence bindings' },
] as const satisfies readonly { value: PlanCleanupKind; label: string; detail: string }[];

function handleAddSelection(value: 'plan' | 'context' | 'sequence'): void {
  if (value === 'plan') emit('addNode');
  else if (value === 'context') emit('addContext');
  else seqPanelRef.value?.openCreate();
}

function sequenceContextTitle(sequenceId: string): string {
  const contexts = contextsBySequenceId.value.get(sequenceId) ?? [];
  if (contexts.length === 0) return '';
  return contexts.map((context) => `${context.title} (${context.type})`).join('\n');
}

function onSequenceContextClick(sequenceId: string): void {
  const context = contextsBySequenceId.value.get(sequenceId)?.[0];
  if (context) emit('contextClick', context.id);
}

function deleteContext(): void {
  if (!props.selectedContextId) return;
  emit('contextDelete', props.selectedContextId);
}

function focusPlanScreen(): void {
  wrapperRef.value?.focus({ preventScroll: true });
}

function shouldIgnoreDeleteKey(): boolean {
  const active = document.activeElement;
  if (active && active !== wrapperRef.value && isEditableElement(active)) return true;
  return Boolean(document.querySelector('.modal-overlay.modal--visible, .scheduled-tasks-tab--popup, .scheduler-popup-backdrop'));
}

function onPlanKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Delete' && event.key !== 'Del') return;
  if (shouldIgnoreDeleteKey()) return;

  if (props.selectedContextId) {
    event.preventDefault();
    emit('contextDelete', props.selectedContextId);
    return;
  }

  if (props.selectedIds.size > 1) return;
  const selectedPlanId = props.selectedIds.size === 1 ? [...props.selectedIds][0] : props.selectedId;
  if (!selectedPlanId) return;
  event.preventDefault();
  emit('deleteNode', selectedPlanId);
}

onUnmounted(() => {
  if (viewportSaveTimer) clearTimeout(viewportSaveTimer);
});
</script>

<template>
  <div
    v-show="visible"
    class="plan-screen"
    :class="{ visible }"
    @mousedown="focusPlanScreen"
  >
    <PanelHeader title="Plans" :subtitle="dirPath" icon="📋">
      <template #actions>
        <div class="plan-header__controls">
          <button class="plan-header__btn" @click="emit('close')">← Back</button>
          <SplitActionButton label="+ Add" :items="[...ADD_ITEMS]" @primary="emit('addNode')" @select="handleAddSelection" />
          <button
            class="plan-header__btn plan-header__btn--secondary"
            :disabled="!selectedId && !relatedFocusActive"
            title="Focus related plans (F)"
            @click="emit('toggleRelatedFocus')"
          >{{ relatedFocusActive ? 'Clear Focus' : 'Focus Related' }}</button>
          <button
            v-if="canPopOut"
            class="plan-header__btn plan-header__btn--secondary"
            title="Open this planner in a detached window"
            @click="emit('popOut')"
          >↗ Pop Out</button>
          <button class="plan-header__btn plan-header__btn--secondary" @click="emit('openPlanExternal')" title="Open selected plan as Markdown (read-only)">📄 Open Plan</button>
          <button class="plan-header__btn plan-header__btn--secondary" @click="emit('exportDir')">⬆ Export Dir</button>
          <SplitActionButton
            class="plan-header__cleanup"
            label="Clear unused"
            title="Clear empty sequences, then contexts with no plan or sequence"
            :items="[...CLEANUP_ITEMS]"
            @primary="emit('cleanup', 'unused')"
            @select="emit('cleanup', $event)"
          />
          <span v-if="notice" class="plan-notice plan-notice--visible">{{ notice }}</span>
        </div>
      </template>

      <template #toolbar>
        <div class="plan-header__filters">
          <FilterChip class="plan-header__chip" :class="filterState(filters.types.bug)" :state="filterState(filters.types.bug)" label="Bug" @update:state="emit('toggleTypeFilter', 'bug')" />
          <FilterChip class="plan-header__chip" :class="filterState(filters.types.feature)" :state="filterState(filters.types.feature)" label="Feature" @update:state="emit('toggleTypeFilter', 'feature')" />
          <FilterChip class="plan-header__chip" :class="filterState(filters.types.research)" :state="filterState(filters.types.research)" label="Research" @update:state="emit('toggleTypeFilter', 'research')" />
          <FilterChip class="plan-header__chip" :class="filterState(filters.types.untyped)" :state="filterState(filters.types.untyped)" label="Untyped" @update:state="emit('toggleTypeFilter', 'untyped')" />
          <span class="plan-header__filter-sep">|</span>
          <FilterChip class="plan-header__chip" :class="filterState(filters.statuses.planning)" :state="filterState(filters.statuses.planning)" label="Planning" @update:state="emit('toggleStatusFilter', 'planning')" />
          <FilterChip class="plan-header__chip" :class="filterState(filters.statuses.ready)" :state="filterState(filters.statuses.ready)" label="Ready" @update:state="emit('toggleStatusFilter', 'ready')" />
          <FilterChip class="plan-header__chip" :class="filterState(filters.statuses.coding)" :state="filterState(filters.statuses.coding)" label="Coding" @update:state="emit('toggleStatusFilter', 'coding')" />
          <FilterChip class="plan-header__chip" :class="filterState(filters.statuses.review)" :state="filterState(filters.statuses.review)" label="Review" @update:state="emit('toggleStatusFilter', 'review')" />
          <FilterChip class="plan-header__chip" :class="filterState(filters.statuses.blocked)" :state="filterState(filters.statuses.blocked)" label="Blocked" @update:state="emit('toggleStatusFilter', 'blocked')" />
          <FilterChip class="plan-header__chip" :class="filterState(filters.statuses.done)" :state="filterState(filters.statuses.done)" label="Done" @update:state="emit('toggleStatusFilter', 'done')" />
          <span class="plan-header__filter-sep">|</span>
          <FilterChip class="plan-header__chip" :class="filterState(filters.hasAttachment?.yes)" :state="filterState(filters.hasAttachment?.yes)" label="Has" @update:state="emit('toggleHasAttachmentFilter', 'yes')" />
          <FilterChip class="plan-header__chip" :class="filterState(filters.hasAttachment?.no)" :state="filterState(filters.hasAttachment?.no)" label="None" @update:state="emit('toggleHasAttachmentFilter', 'no')" />
          <span class="plan-header__filter-sep">|</span>
          <FilterChip class="plan-header__chip" :class="filterState(filters.auto)" :state="filterState(filters.auto)" label="Auto" @update:state="emit('toggleAutoFilter')" />
          <button class="plan-header__btn plan-header__btn--reset" title="Reset filters" @click="emit('resetFilters')">↺</button>
        </div>
      </template>
    </PanelHeader>

    <div
      ref="wrapperRef"
      class="plan-canvas"
      tabindex="0"
      @mousedown="onCanvasMouseDown"
      @mousemove="onCanvasMouseMove"
      @mouseup="onCanvasMouseUp"
      @mouseleave="onCanvasMouseUp"
      @keydown="onPlanKeydown"
      @wheel="onCanvasWheel"
    >
      <svg
        ref="svgRef"
        :viewBox="`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`"
      >
        <defs>
          <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" fill="var(--text-dim)" />
          </marker>
        </defs>

        <g
          v-for="box in sequenceBoxes"
          :key="box.sequence.id"
          class="plan-sequence-lane"
          :class="{
            'plan-sequence-lane--empty': box.isEmpty,
            'plan-sequence-lane--drop-target': seqDragState?.hoveredSeqId === box.sequence.id || contextLinkState?.hoveredSeqId === box.sequence.id,
          }"
          :transform="`translate(${box.x}, ${box.y})`"
        >
          <rect
            :width="box.width"
            :height="box.height"
            rx="8"
            ry="8"
          />
          <foreignObject x="10" y="8" :width="Math.max(120, box.width - 44)" height="28">
            <div
              xmlns="http://www.w3.org/1999/xhtml"
              class="plan-sequence-lane__title"
            >
              {{ box.sequence.title }}
              <button
                v-if="box.sequence.contextIds?.length"
                type="button"
                class="plan-sequence-lane__context-dot"
                :title="sequenceContextTitle(box.sequence.id)"
                @click.stop="onSequenceContextClick(box.sequence.id)"
              >{{ box.sequence.contextIds.length }}</button>
            </div>
          </foreignObject>
          <g
            class="plan-seq-edit-btn"
            :transform="`translate(${box.width - 30}, 6)`"
            @mousedown.stop
            @mouseup.stop
            @click.stop="seqPanelRef?.openEdit(box.sequence)"
          >
            <title>Edit sequence</title>
            <rect width="22" height="20" rx="4" pointer-events="all" />
            <text x="11" y="14" text-anchor="middle">✎</text>
          </g>
          <text
            v-if="box.isEmpty"
            class="plan-sequence-lane__placeholder"
            x="50%"
            y="55%"
            text-anchor="middle"
          >Drop plans here</text>
        </g>

        <text
          v-if="unlinkedZone"
          class="plan-unlinked-label"
          :x="unlinkedZone.x"
          :y="unlinkedZone.y"
        >Unlinked</text>

        <path
          v-for="dep in deps"
          :key="`${dep.fromId}-${dep.toId}`"
          class="plan-arrow"
          :class="{ 'plan-arrow--related-background': isDepRelatedBackground(dep) }"
          :d="depPath(dep)"
          fill="none"
          stroke="var(--text-dim)"
          stroke-width="1.5"
          marker-end="url(#arrowhead)"
          @click.stop="emit('removeDep', dep.fromId, dep.toId)"
        />

        <path
          v-if="dragPath"
          class="plan-drag-line"
          :d="dragPath"
          fill="none"
          stroke="var(--accent)"
          stroke-width="2"
          stroke-dasharray="6 3"
        />

        <path
          v-if="contextLinkPath"
          class="plan-drag-line plan-drag-line--context"
          :d="contextLinkPath"
          fill="none"
          stroke="var(--status-blocked)"
          stroke-width="2"
          stroke-dasharray="6 3"
        />

        <g
          v-for="item in positionedItems"
          :key="item.id"
          class="plan-node"
          :class="{
            'plan-node--selected': item.id === selectedId,
            'plan-node--multiselected': selectedIds.has(item.id) && item.id !== selectedId,
            'plan-node--done': item.status === 'done',
            'plan-node--drop-target': contextLinkState?.hoveredPlanId === item.id,
            'plan-node--related-background': isRelatedBackground(item.id),
            'plan-node--related-transient': relatedTransientIds.has(item.id),
          }"
          :data-id="item.id"
          :transform="`translate(${item.x}, ${item.y})`"
          @click.stop="emit('nodeClick', item.id, $event)"
          @dblclick.stop="emit('editNode', item.id)"
          @mousedown="onNodeBodyMouseDown(item.id, $event)"
        >
          <rect
            width="200"
            height="102"
            rx="10"
            ry="10"
            fill="var(--bg-tertiary)"
            stroke="var(--border)"
            stroke-width="1.5"
          />
          <circle
            cx="18"
            cy="18"
            r="7"
            :fill="getNodeColor(item.status)"
          />
          <foreignObject x="32" y="6" width="160" height="20">
            <div xmlns="http://www.w3.org/1999/xhtml" class="plan-node__title">{{ getDisplayTitle(item.title, item.type) }}</div>
          </foreignObject>
          <foreignObject x="8" y="26" width="184" height="14">
            <div xmlns="http://www.w3.org/1999/xhtml" class="plan-node__meta">
              {{ item.humanId || 'Plan' }} · C {{ formatDate(item.createdAt) }} · S {{ formatDate(item.stateUpdatedAt || item.updatedAt) }}
            </div>
          </foreignObject>
          <foreignObject x="8" y="42" width="184" :height="item.stateInfo || item.autoImplement || contextCountByPlanId.get(item.id) ? 24 : 34">
            <div xmlns="http://www.w3.org/1999/xhtml" class="plan-node__desc">{{ item.description }}</div>
          </foreignObject>
          <foreignObject v-if="item.stateInfo || item.autoImplement || item.completionRecap || contextCountByPlanId.get(item.id) || attachmentHasAny?.[item.id]" x="8" y="78" width="184" height="18">
            <div xmlns="http://www.w3.org/1999/xhtml" class="plan-node__bottom-row">
              <div v-if="item.stateInfo" class="plan-node__state-info">{{ item.stateInfo }}</div>
              <div class="plan-node__bottom-badges">
                <span v-if="attachmentHasAny?.[item.id]" class="plan-node__attachment-badge">📎</span>
                <span v-if="item.autoImplement" class="plan-node__auto-badge">Auto</span>
                <span v-if="item.completionRecap" class="plan-node__auto-badge">Recap</span>
                <span v-if="contextCountByPlanId.get(item.id)" class="plan-context-badge">{{ contextCountByPlanId.get(item.id) }}</span>
              </div>
            </div>
          </foreignObject>
          <g
            v-if="item.sequenceId"
            class="plan-node__unlink"
            @mousedown.stop
            @mouseup.stop
            @click.stop="unlinkFromSequence(item.id, $event)"
          >
            <title>Unlink from sequence</title>
            <circle cx="190" cy="12" r="8" />
            <path d="M185 12h4" />
            <path d="M191 12h4" />
            <path d="M188.5 9.5l3 5" />
          </g>
          <circle
            class="plan-node__connector plan-node__connector--in"
            cx="0"
            cy="51"
            :r="CONNECTOR_R"
            fill="var(--border)"
            stroke="var(--text-dim)"
            stroke-width="1"
          />
          <circle
            class="plan-node__connector plan-node__connector--out"
            cx="200"
            cy="51"
            :r="CONNECTOR_R"
            fill="var(--border)"
            stroke="var(--text-dim)"
            stroke-width="1"
            @mousedown.stop="startDragConnection(item.id, $event)"
          />
        </g>

        <g
          v-for="context in positionedContexts"
          :key="context.id"
          class="plan-context-card"
          :class="{ 'plan-context-card--selected': context.id === selectedContextId }"
          :transform="`translate(${contextDragState?.id === context.id ? contextDragState.x : context.x}, ${contextDragState?.id === context.id ? contextDragState.y : context.y})`"
          @dblclick.stop="emit('contextEdit', context.id)"
          @mousedown="onContextMouseDown(context.id, $event)"
        >
          <rect :width="CONTEXT_W" :height="CONTEXT_H" rx="12" ry="12" />
          <foreignObject x="12" y="10" :width="CONTEXT_W - 24" height="22">
            <div xmlns="http://www.w3.org/1999/xhtml" class="plan-context-card__title">{{ context.title }}</div>
          </foreignObject>
          <foreignObject x="12" y="34" :width="CONTEXT_W - 24" height="18">
            <div xmlns="http://www.w3.org/1999/xhtml" class="plan-context-card__meta">
              <span>{{ context.type }}</span>
              <span class="plan-context-card__permission">{{ context.permission }}</span>
            </div>
          </foreignObject>
          <foreignObject x="12" y="56" :width="CONTEXT_W - 24" height="48">
            <div xmlns="http://www.w3.org/1999/xhtml" class="plan-context-card__content">{{ context.content }}</div>
          </foreignObject>
          <foreignObject x="12" y="108" :width="CONTEXT_W - 24" height="16">
            <div xmlns="http://www.w3.org/1999/xhtml" class="plan-context-card__bound">
              Bound to {{ (context.sequenceIds?.length ?? 0) + (context.planIds?.length ?? 0) }}
              target<span v-if="((context.sequenceIds?.length ?? 0) + (context.planIds?.length ?? 0)) !== 1">s</span>
            </div>
          </foreignObject>
          <circle
            class="plan-context-card__connector"
            :cx="CONTEXT_W"
            :cy="CONTEXT_H / 2"
            :r="CONNECTOR_R"
            @mousedown.stop="startContextLink(context.id, $event)"
          />
        </g>

        <text v-if="items.length === 0" class="plan-canvas-empty" x="50%" y="45%" text-anchor="middle">
          No plan items yet
        </text>
        <text v-if="items.length === 0" class="plan-canvas-empty-hint" x="50%" y="55%" text-anchor="middle">
          Click + Add or press Y to create your first item
        </text>
      </svg>
    </div>

    <div class="plan-controls-hint">
      <span>Y add</span>
      <span>A edit</span>
      <span>X delete</span>
      <span>B back or deselect</span>
      <span>Double click edit</span>
      <span>Drag node to sequence</span>
      <span>Drag connector to link</span>
      <span>F focus related</span>
    </div>

    <div v-if="selectedItem" class="plan-inspector">
      <div class="plan-inspector__header">
        <span class="plan-inspector__title">{{ selectedItem?.title }}</span>
      </div>
    </div>

    <SequencePanel
      ref="seqPanelRef"
      :sequences="sequences"
      :selected-item="selectedItem"
      @create-sequence="(t, m, s) => emit('createSequence', t, m, s)"
      @update-sequence="(id, u) => emit('updateSequence', id, u)"
      @delete-sequence="(id) => emit('deleteSequence', id)"
      @delete-sequence-with-plans="(id) => emit('deleteSequenceWithPlans', id)"
    />
  </div>
</template>

<style scoped>
/*
 * PlanScreen owns the plan canvas, header, nodes, sequences, arrows,
 * inspector, notices, and controls-hint class families.
 * The plan-header__chip family remains global because SkillsTab.vue also
 * renders it. Sequence modal styles live in SequencePanel.vue because its
 * modal is teleported to body.
 */
.plan-screen {
  display: none;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: var(--bg-primary);
}
.plan-screen.visible {
  display: flex;
}

.plan-header__btn {
  padding: 4px 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
}
.plan-header__btn:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
.plan-header__btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.plan-header__btn:disabled:hover {
  background: var(--bg-tertiary);
  border-color: var(--border);
  color: var(--text-dim);
}
.plan-header__btn:hover {
  background: var(--bg-hover);
  border-color: var(--accent);
  color: var(--accent);
}

.plan-header__btn--secondary {
  border-color: var(--text-dim);
  color: var(--text-secondary);
}

.plan-header__btn--secondary:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.plan-header__controls {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}

.plan-header__filters {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  flex-wrap: wrap;
}
.plan-header__filters :deep(.filter-chip) {
  font-size: var(--font-size-xs);
}
.plan-header__filter-sep {
  color: var(--text-dim);
  font-size: 12px;
  padding: 0 2px;
  user-select: none;
}
.plan-header__btn--reset {
  padding: 2px 6px;
  font-size: 13px;
  line-height: 1;
  margin-left: 4px;
}

.plan-notice {
  font-size: 12px;
  color: var(--accent);
  opacity: 0;
  transition: opacity 0.2s;
  white-space: nowrap;
}

.plan-notice--visible {
  opacity: 1;
}

.plan-canvas {
  flex: 1;
  overflow: hidden;
  cursor: grab;
}
.plan-canvas:active {
  cursor: grabbing;
}
.plan-canvas svg {
  width: 100%;
  height: 100%;
}

.plan-node { cursor: pointer; }
.plan-node:hover rect { stroke-width: 2; }
.plan-node--selected rect { stroke-width: 2.5; stroke: var(--accent) !important; }
.plan-node--done { opacity: 0.5; }
.plan-node--done .plan-node__title { text-decoration: line-through; }
.plan-node--related-background:not(.plan-node--selected) {
  opacity: 0.24;
  filter: grayscale(0.8);
}
.plan-node--related-background:not(.plan-node--selected) rect {
  stroke-dasharray: 4 4;
}
.plan-node--related-transient:not(.plan-node--selected) rect {
  stroke: var(--accent);
  stroke-dasharray: 5 3;
}

.plan-node__title {
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 20px;
  pointer-events: none;
  user-select: none;
}

.plan-node__meta {
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  line-height: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
  user-select: none;
}

.plan-node__desc {
  color: var(--text-primary);
  font-size: 11px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  line-height: 13px;
  pointer-events: none;
  user-select: none;
  word-break: break-word;
}

.plan-node__state-info {
  color: var(--text-secondary);
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 18px;
  pointer-events: none;
  user-select: none;
}

.plan-sequence-lane {
  pointer-events: none;
}
.plan-sequence-lane rect {
  fill: color-mix(in srgb, var(--accent) 6%, transparent);
  stroke: color-mix(in srgb, var(--accent) 45%, transparent);
  stroke-width: 1.5;
  stroke-dasharray: 9 5;
}

.plan-arrow { cursor: pointer; }
.plan-arrow:hover { stroke: var(--text-secondary) !important; stroke-width: 2.5; }
.plan-arrow--related-background {
  opacity: 0.18;
  stroke-dasharray: 6 5;
}

.plan-canvas-empty {
  font-size: 16px;
  fill: var(--text-dim);
  pointer-events: none;
}
.plan-canvas-empty-hint {
  font-size: 12px;
  fill: var(--text-dim);
  pointer-events: none;
}

.plan-controls-hint {
  display: flex;
  gap: 16px;
  padding: 6px 16px;
  background: var(--bg-primary);
  border-top: 1px solid var(--bg-tertiary);
  font-size: 11px;
  color: var(--text-dim);
  flex-wrap: wrap;
}
.plan-controls-hint span::before {
  content: '·';
  margin-right: 4px;
  color: var(--border);
}

.plan-inspector {
  display: flex;
  flex-direction: column;
  flex: 0 0 auto;
  max-height: min(42vh, 360px);
  background: var(--bg-secondary);
  border-top: 1px solid var(--bg-hover);
  overflow: hidden;
}

.plan-inspector__header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
}

.plan-inspector__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plan-inspector__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  overflow: auto;
  padding: 10px 12px 12px;
}

.plan-inspector__section {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  gap: 8px;
}

.plan-inspector__section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 700;
}

.plan-node__connector { cursor: crosshair; }
.plan-node__connector:hover { fill: var(--accent); stroke: var(--accent); }

@keyframes plan-shake {
  0%, 100% { transform: translateX(0); }
  20% { transform: translateX(-4px); }
  40% { transform: translateX(4px); }
  60% { transform: translateX(-4px); }
  80% { transform: translateX(2px); }
}
.plan-node--shake {
  animation: plan-shake 0.4s ease;
}

.plan-drag-line { pointer-events: none; }

.plan-node--multiselected rect:first-child {
  stroke: var(--accent);
  stroke-width: 2;
}
.plan-node--drop-target rect:first-child {
  stroke: var(--status-blocked);
  stroke-width: 2.5;
}
.plan-node__unlink {
  cursor: pointer;
}
.plan-node__unlink circle {
  fill: rgba(46, 58, 76, 0.92);
  stroke: var(--info);
  stroke-width: 1.5;
  pointer-events: all;
}
.plan-node__unlink path {
  fill: none;
  stroke: var(--text-secondary);
  stroke-linecap: round;
  stroke-width: 1.4;
  pointer-events: none;
}
.plan-node__unlink:hover circle {
  fill: rgba(58, 75, 102, 0.96);
  stroke: var(--accent);
  stroke-width: 2;
}
.plan-node__unlink:hover path {
  stroke: var(--text-primary);
}
.plan-node__attachment-badge {
  display: inline-flex;
  align-items: center;
  min-height: 16px;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 10px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  user-select: none;
}
.plan-node__bottom-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  width: 100%;
  height: 18px;
  min-width: 0;
}
.plan-node__bottom-badges {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  margin-left: auto;
}
.plan-context-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--status-blocked) 18%, transparent);
  color: var(--status-blocked);
  font-size: 11px;
  font-weight: 700;
  line-height: 18px;
}
.plan-node__auto-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 16px;
  padding: 0 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--status-coding) 18%, transparent);
  border: 1px solid color-mix(in srgb, var(--status-coding) 45%, transparent);
  color: var(--accent-hover);
  font-size: 10px;
  font-weight: 700;
}
.plan-seq-edit-btn {
  cursor: pointer;
}
.plan-seq-edit-btn rect {
  fill: var(--bg-tertiary);
  stroke: var(--text-dim);
  stroke-width: 1;
}
.plan-seq-edit-btn text {
  fill: var(--text-secondary);
  font-size: 12px;
  pointer-events: none;
  user-select: none;
}
.plan-seq-edit-btn:hover rect {
  fill: var(--bg-hover);
  stroke: var(--text-secondary);
}
.plan-seq-edit-btn:hover text {
  fill: var(--text-primary);
}
.plan-sequence-lane--empty rect {
  stroke-dasharray: 6 4;
  stroke: var(--text-dim);
  fill: transparent;
}
.plan-sequence-lane--empty .plan-sequence-lane__placeholder {
  fill: var(--text-dim);
  font-size: 12px;
}
.plan-sequence-lane--drop-target rect {
  stroke: var(--status-coding);
  stroke-width: 2.5;
  fill: color-mix(in srgb, var(--status-coding) 8%, transparent);
}
.plan-sequence-lane__title {
  cursor: pointer;
  font-weight: 600;
  font-size: 13px;
  color: var(--text-primary);
  line-height: 24px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plan-sequence-lane__title:hover {
  color: var(--accent);
}
.plan-sequence-lane__context-dot {
  border: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 6px;
  margin-left: 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--status-blocked) 18%, transparent);
  color: var(--status-blocked);
  cursor: pointer;
  font-size: 11px;
  font-weight: 700;
}
.plan-sequence-lane__context-dot:hover,
.plan-sequence-lane__context-dot:focus-visible {
  background: color-mix(in srgb, var(--status-blocked) 32%, transparent);
  color: var(--text-primary);
  outline: 1px solid color-mix(in srgb, var(--status-blocked) 70%, transparent);
}
.plan-unlinked-label {
  fill: var(--text-dim);
  font-size: 13px;
  font-weight: 600;
  user-select: none;
}
.plan-context-card {
  cursor: grab;
}
.plan-context-card rect {
  fill: color-mix(in srgb, var(--status-blocked) 8%, transparent);
  stroke: color-mix(in srgb, var(--status-blocked) 72%, transparent);
  stroke-width: 1.5;
}
.plan-context-card--selected rect {
  stroke: var(--status-blocked);
  stroke-width: 2.5;
}
.plan-context-card__title {
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.plan-context-card__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 11px;
}
.plan-context-card__permission {
  color: var(--status-blocked);
  font-size: 10px;
  text-transform: uppercase;
}
.plan-context-card__content {
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 14px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  word-break: break-word;
}
.plan-context-card__bound {
  color: var(--text-dim);
  font-size: 10px;
}
.plan-context-card__connector {
  fill: var(--bg-primary);
  stroke: var(--status-blocked);
  stroke-width: 1.5;
  cursor: crosshair;
}
.plan-context-card__connector:hover {
  fill: var(--status-blocked);
  stroke: var(--text-primary);
}
</style>
