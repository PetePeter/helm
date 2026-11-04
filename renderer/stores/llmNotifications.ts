import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

export interface LlmNotification {
  id: string;
  sessionId: string;
  title: string;
  content: string;
  createdAt: number;
  /** A note the user wrote on the row (📝); absent for LLM notifications. */
  kind?: 'note';
}

const STORAGE_KEY = 'helm.llmNotifications.v1';

function loadPersisted(): LlmNotification[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => entry && typeof entry.id === 'string' && typeof entry.sessionId === 'string' && typeof entry.title === 'string' && typeof entry.content === 'string')
      .map((entry) => ({
        id: entry.id,
        sessionId: entry.sessionId,
        title: entry.title,
        content: entry.content,
        createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
        ...(entry.kind === 'note' ? { kind: 'note' as const } : {}),
      }));
  } catch {
    return [];
  }
}

function persist(notifications: LlmNotification[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notifications));
  } catch {
    // ignore persistence failures
  }
}

export const useLlmNotificationsStore = defineStore('llmNotifications', () => {
  const notifications = ref<LlmNotification[]>(loadPersisted());

  const bySession = computed(() => {
    const grouped = new Map<string, LlmNotification[]>();
    for (const notification of notifications.value) {
      const existing = grouped.get(notification.sessionId) ?? [];
      existing.push(notification);
      grouped.set(notification.sessionId, existing);
    }
    return grouped;
  });

  function add(input: { sessionId: string; title: string; content: string; kind?: 'note' }): void {
    notifications.value = [{
      id: `${input.sessionId}-${Date.now()}`,
      sessionId: input.sessionId,
      title: input.title,
      content: input.content,
      createdAt: Date.now(),
      ...(input.kind ? { kind: input.kind } : {}),
    }, ...notifications.value];
    persist(notifications.value);
  }

  function dismiss(notificationId: string): void {
    const next = notifications.value.filter((notification) => notification.id !== notificationId);
    if (next.length === notifications.value.length) return;
    notifications.value = next;
    persist(notifications.value);
  }

  function dismissSession(sessionId: string): void {
    const next = notifications.value.filter((notification) => notification.sessionId !== sessionId);
    if (next.length === notifications.value.length) return;
    notifications.value = next;
    persist(notifications.value);
  }

  function clear(): void {
    notifications.value = [];
    persist(notifications.value);
  }

  return { notifications, bySession, add, dismiss, dismissSession, clear };
});
