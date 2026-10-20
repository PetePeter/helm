<script setup lang="ts">
/**
 * SettingsScreen.vue — full-screen settings: grouped nav on the left, the
 * active page on the right (rendered by the parent through the default slot).
 *
 * Gamepad model: panes are the nav plus every innermost SettingsPane the page
 * renders, left to right. ◀▶ change pane, ▲▼ move within it (in the nav that
 * switches page), A enters/activates, B walks back pane by pane and closes
 * from the nav, LB/RB step the page's sub-tabs. Pages register panes and
 * sub-tabs through provide/inject (settings-panes.ts), so there is no
 * per-page wiring here.
 */
import { nextTick, ref } from 'vue';
import { innermostPanes, provideSettingsPanes } from './settings-panes.js';
import { navigateFocus, getFocusableElements, toDirection } from '../../utils.js';
import { SETTINGS_GROUPS, SETTINGS_ICONS, pagesInGroup, stepSettingsPage } from './settings-registry.js';

const props = defineProps<{ activeTab: string }>();

const emit = defineEmits<{
  'update:activeTab': [tabId: string];
  close: [];
}>();

const registry = provideSettingsPanes();
const navRef = ref<HTMLElement | null>(null);
const navItems = new Map<string, HTMLElement>();
/** 0 = nav; n = the nth content pane. */
const paneIndex = ref(0);

const contentPanes = () => innermostPanes(registry);

function setNavItem(id: string, el: unknown): void {
  if (el instanceof HTMLElement) navItems.set(id, el);
  else navItems.delete(id);
}

function focusNav(): void {
  paneIndex.value = 0;
  navItems.get(props.activeTab)?.focus();
}

/** Focus pane `index`, preferring the item that was focused when we left it. */
function focusPane(index: number): void {
  const panes = contentPanes();
  if (index <= 0) { focusNav(); return; }
  const pane = panes[Math.min(index, panes.length) - 1];
  if (!pane) return;
  paneIndex.value = Math.min(index, panes.length);
  const remembered = lastFocused.get(pane);
  const target = remembered && pane.contains(remembered) ? remembered : getFocusableElements(pane)[0];
  target?.focus();
}

/** Last focused element per pane, so B lands back where the user was. */
const lastFocused = new WeakMap<HTMLElement, HTMLElement>();
function onFocusIn(event: FocusEvent): void {
  const target = event.target as HTMLElement;
  const panes = contentPanes();
  const index = panes.findIndex((pane) => pane.contains(target));
  if (index >= 0) {
    lastFocused.set(panes[index], target);
    paneIndex.value = index + 1;
  } else if (navRef.value?.contains(target)) {
    paneIndex.value = 0;
  }
}

function isTextField(el: Element | null): boolean {
  return el instanceof HTMLTextAreaElement
    || (el instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'range'].includes(el.type));
}

function selectPage(id: string): void {
  emit('update:activeTab', id);
  // Keep the nav focus on the newly active item once it re-renders.
  void nextTick(() => { if (paneIndex.value === 0) focusNav(); });
}

function cycleSubTab(delta: number): void {
  registry.subTabs[0]?.cycle(delta);
}

function handleButton(button: string): boolean {
  if (button.startsWith('Arrow') && isTextField(document.activeElement)) return false;
  if (button === 'LeftBumper') { cycleSubTab(-1); return true; }
  if (button === 'RightBumper') { cycleSubTab(1); return true; }
  if (button === 'B') {
    if (paneIndex.value > 0) focusPane(paneIndex.value - 1);
    else emit('close');
    return true;
  }
  if (button === 'A') {
    const active = document.activeElement as HTMLElement | null;
    if (paneIndex.value === 0) {
      if (active && navRef.value?.contains(active) && active !== navItems.get(props.activeTab)) {
        active.click();
        return true;
      }
      focusPane(1);
      return true;
    }
    if (active?.classList.contains('focusable')) active.click();
    return true;
  }
  const dir = toDirection(button.replace(/^Arrow/, 'DPad'));
  if (dir === 'left') { focusPane(paneIndex.value - 1); return true; }
  if (dir === 'right') { focusPane(paneIndex.value + 1); return true; }
  if (dir === 'up' || dir === 'down') {
    const delta = dir === 'up' ? -1 : 1;
    if (paneIndex.value === 0) selectPage(stepSettingsPage(props.activeTab, delta));
    else navigateFocus(delta, contentPanes()[paneIndex.value - 1]);
    return true;
  }
  return false;
}

defineExpose({ handleButton });
</script>

<template>
  <div class="settings-screen" @focusin="onFocusIn">
    <nav ref="navRef" class="settings-nav" aria-label="Settings">
      <button class="settings-nav__back focusable" title="Close settings (B)" @click="emit('close')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
        Settings
      </button>
      <template v-for="group in SETTINGS_GROUPS" :key="group">
        <div class="settings-nav__group">{{ group }}</div>
        <button
          v-for="page in pagesInGroup(group)"
          :key="page.id"
          :ref="(el) => setNavItem(page.id, el)"
          class="settings-nav__item focusable"
          :class="{ 'settings-nav__item--active': page.id === activeTab }"
          :aria-current="page.id === activeTab ? 'page' : undefined"
          @click="selectPage(page.id)"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="SETTINGS_ICONS[page.icon]" /></svg>
          {{ page.label }}
          <kbd v-if="page.shortcut" class="dock-tab__shortcut jump-key">{{ page.shortcut }}</kbd>
        </button>
      </template>
    </nav>
    <main class="settings-screen__content">
      <slot :active-tab="activeTab" />
    </main>
  </div>
</template>

<style scoped>
.settings-screen {
  display: grid;
  grid-template-columns: 210px minmax(0, 1fr);
  flex: 1;
  min-width: 0;
  min-height: 0;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow: hidden;
}

.settings-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--spacing-md) var(--spacing-sm);
  background: var(--bg-primary);
  border-right: 1px solid var(--border);
  overflow-y: auto;
}

.settings-nav__back,
.settings-nav__item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 6px 10px;
  border: 0;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--font-size-md);
  text-align: left;
  cursor: pointer;
}

.settings-nav__back {
  color: var(--text-primary);
  font-weight: 600;
  margin-bottom: var(--spacing-xs);
}

.settings-nav svg {
  width: 15px;
  height: 15px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.settings-nav__item:hover,
.settings-nav__back:hover {
  background: var(--bg-hover);
}

.settings-nav__item--active,
.settings-nav__item--active:hover {
  background: var(--accent-tint);
  color: var(--accent);
}

.settings-nav__back:focus-visible,
.settings-nav__item:focus-visible,
.settings-nav__back:focus,
.settings-nav__item:focus {
  outline: none;
  box-shadow: var(--focus-ring);
}

.settings-nav__group {
  margin: var(--spacing-md) 10px 3px;
  font-size: var(--font-size-xs);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-dim);
}

.settings-screen__content {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
</style>
