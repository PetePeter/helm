import { onMounted, ref } from 'vue';
import { profileClient } from '../ipc/clients.js';

/** The active profile role is loaded from the main process and defaults closed. */
export function useActiveProfileRole() {
  const isAdmin = ref(false);
  let loading: Promise<void> | undefined;

  function loadRole(): Promise<void> {
    if (!loading) {
      loading = profileClient.profileActive()
        .then(profile => { isAdmin.value = profile.isAdmin === true; })
        .catch(() => { isAdmin.value = false; });
    }
    return loading;
  }

  onMounted(() => { void loadRole(); });

  return { isAdmin, loadRole };
}
