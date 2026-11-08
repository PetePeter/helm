<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { profileClient } from '../../ipc/clients.js';
import { FORM_KEYS, SELECTION_KEYS, useModalStack } from '../../composables/useModalStack.js';
import { toDirection } from '../../utils.js';

const emit = defineEmits<{ (event: 'manage'): void }>();
type Profile = Awaited<ReturnType<typeof profileClient.profileList>>[number];
type ActiveProfile = Awaited<ReturnType<typeof profileClient.profileActive>>;
const active = ref<ActiveProfile | null>(null);
const profiles = ref<Profile[]>([]);
const open = ref(false);
const selectedIndex = ref(0);
const pinProfile = ref<Profile | null>(null);
const pin = ref('');
const error = ref('');
const pinInput = ref<HTMLInputElement | null>(null);
const modalStack = useModalStack();
const itemCount = computed(() => profiles.value.length + 1);

async function refresh(): Promise<void> {
  const [current, all] = await Promise.all([profileClient.profileActive(), profileClient.profileList()]);
  active.value = current;
  profiles.value = all;
}

function close(): void {
  open.value = false;
  pinProfile.value = null;
  pin.value = '';
  error.value = '';
}

function openSwitcher(): void {
  open.value = true;
}

async function selectProfile(profile: Profile): Promise<void> {
  if (profile.id === active.value?.id) { close(); return; }
  error.value = '';
  if (profile.hasPin && !pinProfile.value) {
    pinProfile.value = profile;
    pin.value = '';
    await nextTick();
    pinInput.value?.focus();
    return;
  }
  const result = await profileClient.profileSwitch(profile.id, profile.hasPin ? pin.value : undefined);
  if (!result.ok) {
    if (result.pinRequired) {
      pinProfile.value = profile;
      pin.value = '';
      await nextTick();
      pinInput.value?.focus();
    }
    error.value = result.retryAfterMs
      ? `${result.error ?? 'Try again later'} (${Math.ceil(result.retryAfterMs / 1000)}s)`
      : result.error ?? 'Could not switch profiles';
    return;
  }
  close();
}

function activate(index: number): void {
  if (index === profiles.value.length) {
    close();
    emit('manage');
    return;
  }
  const profile = profiles.value[index];
  if (profile) void selectProfile(profile);
}

function handleButton(button: string): boolean {
  const direction = toDirection(button);
  if (direction === 'up') selectedIndex.value = (selectedIndex.value - 1 + itemCount.value) % itemCount.value;
  else if (direction === 'down') selectedIndex.value = (selectedIndex.value + 1) % itemCount.value;
  else if (button === 'A') {
    if (pinProfile.value) void selectProfile(pinProfile.value);
    else activate(selectedIndex.value);
  } else if (button === 'B') {
    if (pinProfile.value) { pinProfile.value = null; pin.value = ''; error.value = ''; }
    else close();
  }
  return true;
}

function updateModal(): void {
  if (!open.value) { modalStack.pop('profile-switcher'); return; }
  modalStack.push({
    id: 'profile-switcher',
    handler: handleButton,
    interceptKeys: pinProfile.value ? FORM_KEYS : SELECTION_KEYS,
  });
}

watch([open, pinProfile], updateModal);
let stopRegistryChanged: (() => void) | undefined;
onMounted(() => {
  void refresh();
  stopRegistryChanged = profileClient.profileOnRegistryChanged(() => { void refresh(); });
});
onUnmounted(() => {
  modalStack.pop('profile-switcher');
  stopRegistryChanged?.();
});

defineExpose({ handleButton, open: openSwitcher });
</script>

<template>
  <button
    class="profile-switcher-trigger"
    aria-label="Switch user profile"
    :title="`Active profile: ${active?.name ?? 'Loading'}`"
    @click="openSwitcher"
  >
    <span class="profile-switcher-trigger__icon" aria-hidden="true">◉</span>
    <span>{{ active?.name ?? 'Profile' }}</span>
    <span v-if="active?.isAdmin" class="profile-admin-badge">Admin</span>
    <span class="profile-switcher-trigger__chevron" aria-hidden="true">▾</span>
  </button>

  <Teleport to="body">
    <div v-if="open" class="modal-overlay modal--visible profile-switcher-overlay" role="dialog" aria-label="Switch user profile">
      <section class="profile-switcher-modal">
        <header class="profile-switcher-modal__header">
          <h2>{{ pinProfile ? `Unlock ${pinProfile.name}` : 'Switch profile' }}</h2>
          <p v-if="pinProfile">Enter this profile’s PIN to continue.</p>
          <p v-else>Select the profile for this desktop window.</p>
        </header>

        <form v-if="pinProfile" class="profile-switcher-pin" @submit.prevent="selectProfile(pinProfile)">
          <label for="profile-switcher-pin">Profile PIN</label>
          <input
            id="profile-switcher-pin"
            ref="pinInput"
            v-model="pin"
            type="password"
            inputmode="numeric"
            autocomplete="current-password"
            maxlength="12"
            aria-label="Profile PIN"
          />
        </form>
        <div v-else class="profile-switcher-list" role="menu" aria-label="Profiles">
          <button
            v-for="(profile, index) in profiles"
            :key="profile.id"
            class="profile-switcher-row"
            :class="{ 'profile-switcher-row--selected': selectedIndex === index, 'profile-switcher-row--active': profile.id === active?.id }"
            role="menuitem"
            @mouseenter="selectedIndex = index"
            @click="activate(index)"
          >
            <span class="profile-switcher-row__mark" aria-hidden="true">{{ profile.id === active?.id ? '✓' : '' }}</span>
            <span>{{ profile.name }}</span>
            <span v-if="profile.isAdmin" class="profile-admin-badge">Admin</span>
            <span v-if="profile.hasPin" class="profile-switcher-row__lock" aria-label="PIN protected">●</span>
          </button>
          <button
            class="profile-switcher-row profile-switcher-row--manage"
            :class="{ 'profile-switcher-row--selected': selectedIndex === profiles.length }"
            role="menuitem"
            @mouseenter="selectedIndex = profiles.length"
            @click="activate(profiles.length)"
          >Manage profiles…</button>
        </div>

        <p v-if="error" class="profile-switcher-error" role="alert">{{ error }}</p>
        <footer class="profile-switcher-hints">
          <span><kbd>▲▼</kbd> choose</span><span><kbd>A</kbd> select</span><span><kbd>B</kbd> back</span>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.profile-switcher-trigger {
  display: inline-flex; align-items: center; gap: 7px; max-width: 180px;
  padding: 6px 10px; border: 1px solid var(--border); border-radius: 7px;
  background: var(--bg-primary); color: var(--text-primary); font: inherit; font-size: 12px;
  cursor: pointer; -webkit-app-region: no-drag;
}
.profile-switcher-trigger:hover { border-color: var(--accent); }
.profile-switcher-trigger__icon { color: var(--accent); }
.profile-switcher-trigger__chevron { color: var(--text-dim); }
.profile-admin-badge { padding: 2px 6px; border-radius: 10px; background: var(--accent-tint); color: var(--accent); font-size: var(--font-size-sm); }
.profile-switcher-overlay { z-index: 1200; }
.profile-switcher-modal {
  width: min(360px, calc(100vw - 32px)); padding: 18px;
  border: 1px solid var(--border); border-radius: 12px; background: var(--bg-secondary);
  box-shadow: var(--shadow-lg); color: var(--text-primary);
}
.profile-switcher-modal__header h2 { margin: 0; font-size: 16px; }
.profile-switcher-modal__header p { margin: 6px 0 14px; color: var(--text-secondary); font-size: 12px; }
.profile-switcher-list { display: flex; flex-direction: column; gap: 4px; }
.profile-switcher-row {
  display: flex; align-items: center; gap: 9px; width: 100%; min-height: 38px; padding: 7px 9px;
  border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--text-primary);
  text-align: left; font: inherit; cursor: pointer;
}
.profile-switcher-row--selected { background: var(--accent-tint); color: var(--accent); outline: 1px solid var(--focus-ring); }
.profile-switcher-row__mark { width: 14px; color: var(--accent); }
.profile-switcher-row__lock { margin-left: auto; color: var(--text-dim); font-size: 8px; }
.profile-switcher-row--manage { margin-top: 4px; border-top: 1px solid var(--border); }
.profile-switcher-pin { display: flex; flex-direction: column; gap: 6px; }
.profile-switcher-pin label { font-size: 12px; color: var(--text-secondary); }
.profile-switcher-pin input { padding: 9px; border: 1px solid var(--border); border-radius: 7px; background: var(--bg-primary); color: var(--text-primary); }
.profile-switcher-error { margin: 10px 0 0; color: var(--danger); font-size: 12px; }
.profile-switcher-hints { display: flex; gap: 12px; margin-top: 14px; color: var(--text-dim); font-size: 11px; }
.profile-switcher-hints kbd { padding: 1px 4px; border: 1px solid var(--border); border-radius: 3px; color: var(--text-secondary); }
</style>
