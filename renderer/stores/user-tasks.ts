import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { eventsClient, userTasksClient } from '../ipc/clients.js';
import type { UserTask, UserTaskPatch } from '../../src/types/user-task.js';

/** Renderer mirror of the profile's User Tasks board; main owns the truth. */
export const useUserTasksStore = defineStore('userTasks', () => {
  const tasks = ref<UserTask[]>([]);
  const loaded = ref(false);
  const error = ref('');
  let version = 0;

  eventsClient.onUserTasksChanged?.(change => {
    version++;
    tasks.value = change.tasks;
    loaded.value = true;
    error.value = '';
  });

  async function load(): Promise<void> {
    if (loaded.value) return;
    const at = version;
    try {
      const list = await userTasksClient.userTaskList();
      if (at === version) tasks.value = list;
      error.value = '';
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loaded.value = true;
    }
  }

  const openCount = computed(() => tasks.value.filter(t => t.doneAt === undefined).length);

  const add = (input: { title: string; body?: string; urgent?: boolean; projectId?: string }) =>
    userTasksClient.userTaskAdd(input);
  const update = (id: string, patch: UserTaskPatch) => userTasksClient.userTaskUpdate(id, patch);
  const check = (id: string, itemId: string, done: boolean) => userTasksClient.userTaskCheck(id, itemId, done);
  const remove = (id: string) => userTasksClient.userTaskDelete(id);
  const openAttachment = (taskId: string, attachmentId: string) =>
    userTasksClient.userTaskOpenAttachment(taskId, attachmentId);
  const saveAttachment = (taskId: string, attachmentId: string) =>
    userTasksClient.userTaskSaveAttachment(taskId, attachmentId);
  const readAttachment = (taskId: string, attachmentId: string) =>
    userTasksClient.userTaskReadAttachment(taskId, attachmentId);

  return { tasks, loaded, error, openCount, load, add, update, check, remove, readAttachment, openAttachment, saveAttachment };
});
