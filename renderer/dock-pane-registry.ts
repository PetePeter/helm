/**
 * Pane registry — the single id → component mapping for the dock workspace.
 *
 * `dock-types.ts` owns pane identity (id, kind, title, closable) as plain data so
 * the layout model stays free of Vue. This file is the one place that joins those
 * ids to components; the layout renderer resolves a component by id and never
 * imports a pane directly. Adding a pane means adding a descriptor there and an
 * entry here — the registry test fails if the two drift apart.
 */

import type { Component } from 'vue';
import TerminalPane from './components/dock/TerminalPane.vue';
import PlanScreenPane from './components/dock/PlanScreenPane.vue';
import MemoriesPane from './components/dock/MemoriesPane.vue';
import SessionsPane from './components/dock/SessionsPane.vue';
import SchedulerPane from './components/dock/SchedulerPane.vue';
import QuickSpawnPane from './components/dock/QuickSpawnPane.vue';
import PlanDirectoriesPane from './components/dock/PlanDirectoriesPane.vue';
import ArtifactsPane from './components/dock/ArtifactsPane.vue';
import MessPane from './components/dock/MessPane.vue';
import {
  PANE_ARTIFACTS,
  PANE_PLAN_DIRECTORIES,
  PANE_PLAN_SCREEN,
  PANE_MEMORIES,
  PANE_QUICK_SPAWN,
  PANE_SCHEDULER,
  PANE_SESSIONS,
  PANE_TERMINAL,
  PANE_MESS,
  type PaneId,
} from './dock-types.js';

export const DOCK_PANE_COMPONENTS: Readonly<Record<PaneId, Component>> = Object.freeze({
  [PANE_TERMINAL]: TerminalPane,
  [PANE_PLAN_SCREEN]: PlanScreenPane,
  [PANE_MEMORIES]: MemoriesPane,
  [PANE_SESSIONS]: SessionsPane,
  [PANE_SCHEDULER]: SchedulerPane,
  [PANE_QUICK_SPAWN]: QuickSpawnPane,
  [PANE_PLAN_DIRECTORIES]: PlanDirectoriesPane,
  [PANE_ARTIFACTS]: ArtifactsPane,
  [PANE_MESS]: MessPane,
});

/** Resolve a registered pane's component; undefined for an unknown id. */
export function getPaneComponent(paneId: PaneId): Component | undefined {
  return DOCK_PANE_COMPONENTS[paneId];
}
