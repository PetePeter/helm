/**
 * settings-panes.ts — how settings pages tell SettingsScreen about their
 * gamepad panes and sub-tabs, through provide/inject rather than DOM queries.
 *
 * A pane registers its root element; a pane nested in another marks the outer
 * one as split, so only innermost panes take part (Skills splits the page body
 * into list + detail). A sub-tab strip registers a cycler that LB/RB drive.
 * The registry is read on demand by button handlers, so it needs no reactivity.
 */
import { inject, onBeforeUnmount, onMounted, provide, type InjectionKey, type Ref } from 'vue';

interface PaneEntry {
  el: Ref<HTMLElement | null>;
  children: number;
}

export interface SubTabCycler {
  cycle(delta: number): void;
}

export interface SettingsPaneRegistry {
  panes: PaneEntry[];
  subTabs: SubTabCycler[];
}

const REGISTRY: InjectionKey<SettingsPaneRegistry> = Symbol('settingsPanes');
const PARENT_PANE: InjectionKey<PaneEntry | null> = Symbol('settingsParentPane');

/** Called by SettingsScreen. */
export function provideSettingsPanes(): SettingsPaneRegistry {
  const registry: SettingsPaneRegistry = { panes: [], subTabs: [] };
  provide(REGISTRY, registry);
  return registry;
}

/** Innermost panes, in document (left-to-right) order. */
export function innermostPanes(registry: SettingsPaneRegistry): HTMLElement[] {
  return registry.panes
    .filter((pane) => pane.children === 0)
    .map((pane) => pane.el.value)
    .filter((el): el is HTMLElement => el !== null)
    .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}

function remove<T>(list: T[], item: T): void {
  const index = list.indexOf(item);
  if (index >= 0) list.splice(index, 1);
}

/** Register `el` as a gamepad pane. No-op outside SettingsScreen. */
export function useSettingsPane(el: Ref<HTMLElement | null>): void {
  const registry = inject(REGISTRY, null);
  const parent = inject(PARENT_PANE, null);
  const pane: PaneEntry = { el, children: 0 };
  provide(PARENT_PANE, pane);
  if (!registry) return;
  onMounted(() => {
    registry.panes.push(pane);
    if (parent) parent.children++;
  });
  onBeforeUnmount(() => {
    remove(registry.panes, pane);
    if (parent) parent.children--;
  });
}

/** Register a sub-tab strip so LB/RB step through it. No-op outside SettingsScreen. */
export function useSettingsSubTabs(
  tabs: () => ReadonlyArray<string>,
  current: () => string,
  select: (id: string) => void,
): void {
  const registry = inject(REGISTRY, null);
  if (!registry) return;
  const cycler: SubTabCycler = {
    cycle(delta) {
      const ids = tabs();
      if (ids.length === 0) return;
      const index = ids.indexOf(current());
      select(ids[(((index + delta) % ids.length) + ids.length) % ids.length]);
    },
  };
  onMounted(() => registry.subTabs.push(cycler));
  onBeforeUnmount(() => remove(registry.subTabs, cycler));
}
