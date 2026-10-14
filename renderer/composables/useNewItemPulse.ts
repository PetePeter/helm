import { reactive } from 'vue';
import { eventsClient, messClient } from '../ipc/clients.js';
import { PANE_ARTIFACTS, PANE_MEMORIES, PANE_MESS, PANE_PLAN_SCREEN, type PaneId } from '../dock-types.js';

/** How long one "+1" stays on screen; the CSS fade runs over the same time. */
export const NEW_ITEM_PULSE_MS = 1200;

/** The four "something new arrived" feeds. Injectable so tests can drive them. */
export interface NewItemSources {
  onMemoryChanged(cb: (event: { type?: string }) => void): () => void;
  onMessAppended(cb: () => void): () => void;
  onArtifactCreated(cb: () => void): () => void;
  onPlanCreated(cb: () => void): () => void;
}

const pulses = reactive(new Map<PaneId, number[]>());
let nextPulseId = 0;

/** Live "+1"s for a pane; each id is one badge, removed when its fade ends. */
export function panePulses(paneId: PaneId): readonly number[] {
  return pulses.get(paneId) ?? [];
}

function pulse(paneId: PaneId): void {
  const id = nextPulseId++;
  pulses.set(paneId, [...panePulses(paneId), id]);
  setTimeout(() => pulses.set(paneId, panePulses(paneId).filter((p) => p !== id)), NEW_ITEM_PULSE_MS);
}

const defaultSources: NewItemSources = {
  onMemoryChanged: (cb) => eventsClient.onMemoryChanged(cb),
  onMessAppended: (cb) => messClient.onMessAppended(cb),
  onArtifactCreated: (cb) => eventsClient.onArtifactCreated(cb),
  onPlanCreated: (cb) => eventsClient.onPlanCreated(cb),
};

/** Subscribe once per window. New items only: edits, links and deletes never pulse. */
export function startNewItemPulses(sources: NewItemSources = defaultSources): () => void {
  const stops = [
    sources.onMemoryChanged((event) => { if (event?.type === 'create') pulse(PANE_MEMORIES); }),
    sources.onMessAppended(() => pulse(PANE_MESS)),
    sources.onArtifactCreated(() => pulse(PANE_ARTIFACTS)),
    sources.onPlanCreated(() => pulse(PANE_PLAN_SCREEN)),
  ];
  return () => stops.forEach((stop) => stop());
}
