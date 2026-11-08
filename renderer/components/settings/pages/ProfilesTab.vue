<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import ConfirmDialog from '../../modals/ConfirmDialog.vue';
import FieldRow from '../primitives/FieldRow.vue';
import SettingsCard from '../primitives/SettingsCard.vue';
import { profileClient } from '../../../ipc/clients.js';

type Profile = Awaited<ReturnType<typeof profileClient.profileList>>[number];
const profiles = ref<Profile[]>([]);
const createName = ref('');
const renameNames = ref<Record<string, string>>({});
const pinDraft = ref('');
const error = ref('');
const deleteTarget = ref<Profile | null>(null);
const confirmIndex = ref(0);
const saving = ref(false);
const activeProfile = computed(() => profiles.value.find(profile => profile.isActive) ?? null);
const validPin = computed(() => /^\d{4,12}$/.test(pinDraft.value));

async function refresh(): Promise<void> {
  profiles.value = await profileClient.profileList();
  renameNames.value = Object.fromEntries(profiles.value.map(profile => [profile.id, profile.name]));
}

async function createProfile(): Promise<void> {
  const name = createName.value.trim();
  if (!name || saving.value) return;
  saving.value = true;
  error.value = '';
  try {
    await profileClient.profileCreate(name);
    createName.value = '';
    await refresh();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally { saving.value = false; }
}

async function renameProfile(profile: Profile): Promise<void> {
  const name = renameNames.value[profile.id]?.trim();
  if (!name || name === profile.name || saving.value) return;
  saving.value = true;
  error.value = '';
  try {
    const result = await profileClient.profileRename(profile.id, name);
    if (!result.ok) error.value = result.error ?? 'Could not rename profile';
    else await refresh();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally { saving.value = false; }
}

async function savePin(): Promise<void> {
  if (!activeProfile.value || !validPin.value || saving.value) return;
  saving.value = true;
  error.value = '';
  try {
    const result = await profileClient.profileSetPin(activeProfile.value.id, pinDraft.value);
    if (!result.ok) error.value = result.error ?? 'Could not set PIN';
    else { pinDraft.value = ''; await refresh(); }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally { saving.value = false; }
}

async function clearPin(): Promise<void> {
  if (!activeProfile.value || saving.value) return;
  saving.value = true;
  error.value = '';
  try {
    const result = await profileClient.profileSetPin(activeProfile.value.id, null);
    if (!result.ok) error.value = result.error ?? 'Could not clear PIN';
    else await refresh();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally { saving.value = false; }
}

async function deleteProfile(): Promise<void> {
  if (!deleteTarget.value || saving.value) return;
  saving.value = true;
  error.value = '';
  try {
    const result = await profileClient.profileDelete(deleteTarget.value.id);
    if (!result.ok) error.value = result.error ?? 'Could not delete profile';
    else { deleteTarget.value = null; await refresh(); }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally { saving.value = false; }
}

function onConfirmAction(action: string): void {
  if (action === 'delete') void deleteProfile();
  else deleteTarget.value = null;
}

let stopRegistryChanged: (() => void) | undefined;
onMounted(() => {
  void refresh();
  stopRegistryChanged = profileClient.profileOnRegistryChanged(() => { void refresh(); });
});
onUnmounted(() => stopRegistryChanged?.());
</script>

<template>
  <div class="profiles-tab settings-sections">
    <p class="profiles-intro">
      Each profile has its own tools, projects, sessions, memories, skills, and plans. Use the profile switcher in the main header to change the desktop profile.
    </p>

    <SettingsCard title="Create profile" class="settings-span">
      <FieldRow label="Profile name" hint="Names are visible in the desktop switcher." for="new-profile-name">
        <input id="new-profile-name" v-model="createName" class="input" maxlength="48" aria-label="New profile name" @keyup.enter="createProfile" />
        <button class="btn btn-primary focusable" aria-label="Create profile" :disabled="!createName.trim() || saving" @click="createProfile">Create</button>
      </FieldRow>
    </SettingsCard>

    <SettingsCard title="Profiles" class="settings-span">
      <div v-if="profiles.length === 0" class="profiles-empty">Loading profiles…</div>
      <div v-for="profile in profiles" :key="profile.id" class="profile-row">
        <div class="profile-row__heading">
          <strong>{{ profile.name }}</strong>
          <span v-if="profile.isActive" class="profile-active-badge">Active on this desktop</span>
          <span v-if="profile.hasPin" class="profile-pin-badge">PIN protected</span>
          <span class="profile-row__spacer"></span>
          <button
            v-if="profile.canDelete"
            class="btn btn-danger focusable"
            :aria-label="`Delete ${profile.name}`"
            @click="deleteTarget = profile"
          >Delete</button>
          <span v-else-if="profile.id !== '1'" class="profile-delete-note">
            Delete requires no sessions, recoverable sessions, or paired devices.
          </span>
        </div>
        <FieldRow :label="`Name for ${profile.name}`" :for="`profile-name-${profile.id}`">
          <input :id="`profile-name-${profile.id}`" v-model="renameNames[profile.id]" class="input" maxlength="48" :aria-label="`Rename ${profile.name}`" />
          <button class="btn btn-secondary focusable" :aria-label="`Save name for ${profile.name}`" :disabled="saving || !renameNames[profile.id]?.trim() || renameNames[profile.id]?.trim() === profile.name" @click="renameProfile(profile)">Rename</button>
        </FieldRow>
        <p class="profile-meta">
          {{ profile.sessionCount }} sessions · {{ profile.recoverableSessionCount }} recoverable · {{ profile.deviceCount }} paired devices
        </p>
      </div>
    </SettingsCard>

    <SettingsCard title="Active profile PIN" class="settings-span">
      <p v-if="activeProfile" class="profile-pin-copy">
        Set or clear the PIN for <strong>{{ activeProfile.name }}</strong>. You must switch into a profile before changing its PIN.
      </p>
      <FieldRow label="New PIN" hint="Optional; 4 to 12 digits." for="new-profile-pin">
        <input
          id="new-profile-pin"
          v-model="pinDraft"
          class="input"
          type="password"
          inputmode="numeric"
          autocomplete="new-password"
          maxlength="12"
          aria-label="New profile PIN"
        />
        <button class="btn btn-primary focusable" aria-label="Set profile PIN" :disabled="!validPin || saving" @click="savePin">Set PIN</button>
        <button v-if="activeProfile?.hasPin" class="btn btn-secondary focusable" aria-label="Clear profile PIN" :disabled="saving" @click="clearPin">Clear PIN</button>
      </FieldRow>
    </SettingsCard>

    <p v-if="error" class="profiles-error" role="alert">{{ error }}</p>

    <ConfirmDialog
      :visible="deleteTarget !== null"
      modal-id="delete-user-profile"
      :title="`Delete ${deleteTarget?.name ?? 'profile'}?`"
      aria-label="Confirm profile deletion"
      :buttons="[{ id: 'cancel', label: 'Keep profile', variant: 'secondary' }, { id: 'delete', label: 'Delete data', variant: 'danger' }]"
      :selected-index="confirmIndex"
      cancel-action-id="cancel"
      @update:visible="value => { if (!value) deleteTarget = null; }"
      @update:selected-index="confirmIndex = $event"
      @action="onConfirmAction"
      @cancel="deleteTarget = null"
    >
      <p class="profile-delete-confirm-copy">This removes the profile and its local data directory. Deletion is available only when it has no sessions, recoverable sessions, or paired devices.</p>
    </ConfirmDialog>
  </div>
</template>

<style scoped>
.profiles-tab { padding: 8px; }
.profiles-intro, .profile-pin-copy { margin: 0; color: var(--text-secondary); font-size: var(--font-size-sm); line-height: 1.45; }
.profiles-empty { padding: 10px 0; color: var(--text-dim); font-size: var(--font-size-sm); }
.profile-row { padding: 10px 0; border-bottom: 1px solid var(--border); }
.profile-row:last-child { border-bottom: 0; }
.profile-row__heading { display: flex; align-items: center; gap: 8px; min-height: 32px; color: var(--text-primary); font-size: var(--font-size-sm); }
.profile-row__spacer { flex: 1; }
.profile-active-badge, .profile-pin-badge { padding: 2px 6px; border-radius: 10px; background: var(--accent-tint); color: var(--accent); font-size: 10px; }
.profile-pin-badge { background: var(--bg-tertiary); color: var(--text-secondary); }
.profile-delete-note, .profile-meta { color: var(--text-dim); font-size: 11px; }
.profile-meta { margin: 5px 0 0; }
.profiles-error { color: var(--danger); font-size: var(--font-size-sm); }
.profile-delete-confirm-copy { padding: 0 18px; color: var(--text-secondary); font-size: 12px; line-height: 1.5; }
</style>
