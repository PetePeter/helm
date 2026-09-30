<script setup lang="ts">
/**
 * Fixed bottom-right toast stack.
 *
 * Mount once in App.vue. Each toast auto-dismisses (managed by useToast composable).
 * Listens for incoming plan IPC events and shows success/error toasts.
 * Error toasts are persistent — click to open the file, × to dismiss.
 */
import { onMounted, onUnmounted } from 'vue';
import { useToast } from '../composables/useToast.js';
import { eventsClient, incomingClient } from '../ipc/clients.js';

const { toasts, removeToast, addToast, removeByKey } = useToast();

const cleanups: (() => void)[] = [];

onMounted(() => {
  cleanups.push(
    eventsClient.onPlanIncomingImported(({ title, filename }) => {
      // Auto-clear any previous error toast for this file
      removeByKey(filename);
      addToast({ message: `📥 Plan imported: "${title}"`, type: 'success' });
    }),
    eventsClient.onPlanIncomingError(({ filename, error }) => {
      addToast({
        message: `⚠️ Import failed: ${filename} — ${error}`,
        type: 'error',
        persistent: true,
        key: filename,
        onClick: () => { incomingClient.planIncomingOpen(filename); },
      });
    }),
    eventsClient.onPlanIncomingErrorCleared(({ filename }) => {
      removeByKey(filename);
    }),
  );
});

onUnmounted(() => {
  cleanups.forEach(fn => fn());
});

function handleToastClick(toast: { id: number; onClick?: () => void }): void {
  if (toast.onClick) {
    toast.onClick();
  } else {
    removeToast(toast.id);
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="toast-stack" role="status" aria-live="polite">
      <TransitionGroup name="toast">
        <div
          v-for="toast in toasts"
          :key="toast.id"
          :class="['toast', `toast--${toast.type}`]"
          @click="handleToastClick(toast)"
        >
          <span class="toast-message">{{ toast.message }}</span>
          <button
            v-if="toast.persistent"
            class="toast-close"
            aria-label="Dismiss"
            @click.stop="removeToast(toast.id)"
          >×</button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-stack {
  position: fixed;
  bottom: 16px;
  right: 16px;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
  max-width: 360px;
}

.toast {
  padding: 10px 14px;
  border-radius: 6px;
  font-size: var(--font-size-md);
  line-height: 1.4;
  color: #fff;
  background: #333;
  box-shadow: 0 2px 8px rgba(0,0,0,.4);
  pointer-events: all;
  cursor: pointer;
  word-break: break-word;
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.toast-message { flex: 1; }

.toast-close {
  background: none;
  border: none;
  color: #fff;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
  opacity: 0.7;
  flex-shrink: 0;
}
.toast-close:hover { opacity: 1; }


.toast--success { background: #2a6f2a; }
.toast--error   { background: #7a2020; }
.toast--info    { background: #1e3d6e; }

.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.toast-enter-from {
  opacity: 0;
  transform: translateX(20px);
}
.toast-leave-to {
  opacity: 0;
  transform: translateX(20px);
}
</style>
