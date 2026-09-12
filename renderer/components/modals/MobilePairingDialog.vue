<script setup lang="ts">
/**
 * MobilePairingDialog.vue — the ONE human decision in the phone pairing flow.
 *
 * Shows the 6-digit short-authentication-string derived by the SecureChannel
 * handshake and asks the user to confirm it matches the code on the phone.
 * Confirm → mobileConfirmPairing(true); Reject → …(false). Nothing is persisted
 * until Confirm, so rejecting or walking away leaves no trust behind. The flow is
 * time-boxed (~3 minutes) in the main process; cancelling on unmount aborts it.
 *
 * Deliberately the same shape and the same SAS cell treatment as
 * PeerPairingDialog — one pairing idiom in the app, not two.
 *
 * Gamepad: A confirm, B cancel/reject. Keyboard: Enter confirm, Esc reject.
 */
import { computed, onUnmounted, watch } from 'vue';
import { SELECTION_KEYS, useModalStack } from '../../composables/useModalStack.js';
import { useMobileDevices } from '../../composables/useMobileDevices.js';

const MODAL_ID = 'mobile-pairing';

const { pairing, dialogOpen, confirmPairing, cancelPairing } = useMobileDevices();
const modalStack = useModalStack();

const visible = computed(() => dialogOpen.value);
const status = computed(() => pairing.value.status);
const sas = computed(() => pairing.value.sas ?? null);
const deviceName = computed(() => pairing.value.deviceName ?? 'your phone');
const errorMessage = computed(() => pairing.value.reason ?? null);

/** Six SAS digits split into cells, or placeholders while we wait for the code. */
const sasCells = computed<string[]>(() => {
  const digits = (sas.value ?? '').split('');
  return Array.from({ length: 6 }, (_, i) => digits[i] ?? '•');
});

const canConfirm = computed(() => status.value === 'awaiting-sas' && Boolean(sas.value));

async function onConfirm(): Promise<void> {
  if (!canConfirm.value) return;
  await confirmPairing(true);
}

async function onReject(): Promise<void> {
  await confirmPairing(false);
}

function onCancel(): void {
  void cancelPairing();
}

function handleButton(button: string): boolean {
  if (button === 'A') { void onConfirm(); return true; }
  if (button === 'B') { onCancel(); return true; }
  return true;
}

function onOverlayKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') { event.preventDefault(); void onConfirm(); }
  else if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
}

watch(visible, (v) => {
  if (v) {
    modalStack.push({ id: MODAL_ID, handler: handleButton, interceptKeys: SELECTION_KEYS });
  } else {
    modalStack.pop(MODAL_ID);
  }
}, { immediate: true });

onUnmounted(() => {
  modalStack.pop(MODAL_ID);
  // Abort a still-open flow when the host unmounts, so nothing is left armed.
  if (dialogOpen.value && status.value !== 'paired') {
    void cancelPairing();
  }
});

defineExpose({ handleButton });
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="modal-overlay modal--visible"
      role="dialog"
      aria-label="Confirm phone pairing"
      tabindex="-1"
      @keydown="onOverlayKeydown"
    >
      <div class="modal mobile-pairing-modal">
        <div class="mp-head">
          <h3 class="mp-title">Pair {{ deviceName }}</h3>
        </div>

        <div class="mp-body">
          <template v-if="status === 'scanning'">
            <div class="mp-waiting">Looking for a phone in pairing mode…</div>
            <p class="mp-hint">
              Open Helm on your phone and put it into pairing mode so it starts advertising.
            </p>
          </template>

          <template v-else-if="status !== 'paired'">
            <p class="mp-instruction">
              Do these codes match on <strong>both</strong> screens?
            </p>

            <div v-if="sas" class="mp-sas" aria-label="Short authentication string">
              <span v-for="(cell, i) in sasCells" :key="i" class="mp-sas-cell">{{ cell }}</span>
            </div>
            <div v-else class="mp-waiting">Waiting for the pairing code…</div>

            <p class="mp-timebox">This request expires after about 3 minutes.</p>
          </template>

          <p v-if="status === 'failed' && errorMessage" class="mp-error">{{ errorMessage }}</p>
          <p v-else-if="status === 'paired'" class="mp-success">Paired successfully.</p>
        </div>

        <div v-if="status !== 'paired'" class="mp-footer">
          <button
            class="btn btn--primary mp-confirm"
            type="button"
            :disabled="!canConfirm"
            @click="onConfirm"
          >Confirm</button>
          <button class="btn btn--danger mp-reject" type="button" @click="onReject">Reject</button>
          <button class="btn mp-cancel" type="button" @click="onCancel">Cancel</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.mobile-pairing-modal {
  border: 2px solid var(--accent);
  border-radius: 10px;
  background: var(--bg-secondary);
  width: min(420px, 92vw);
  display: flex;
  flex-direction: column;
}
.mp-head { padding: 16px 20px; border-bottom: 1px solid var(--border); }
.mp-title { margin: 0; font-size: 1.1rem; color: var(--text-primary); }
.mp-body { padding: 20px; display: flex; flex-direction: column; align-items: center; gap: 14px; }
.mp-instruction { margin: 0; color: var(--text-primary); font-size: 0.95rem; text-align: center; }
.mp-instruction strong { color: var(--text-primary); }
.mp-hint { margin: 0; color: var(--text-secondary); font-size: 0.8rem; text-align: center; }
.mp-sas { display: flex; gap: 8px; }
.mp-sas-cell {
  min-width: 40px;
  padding: 12px 0;
  text-align: center;
  font-family: ui-monospace, "Cascadia Code", monospace;
  font-size: 1.8rem;
  font-weight: 700;
  color: var(--text-primary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.mp-waiting { color: var(--text-secondary); font-size: 0.9rem; padding: 18px 0; }
.mp-timebox { margin: 0; color: var(--text-secondary); font-size: 0.78rem; }
.mp-error { margin: 0; color: #ff6666; font-size: 0.85rem; text-align: center; }
.mp-success { margin: 0; color: #44cc44; font-size: 0.85rem; text-align: center; }
.mp-footer {
  display: flex;
  gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid var(--border);
  justify-content: flex-end;
}
</style>
