/**
 * Copy a string and remember it briefly, so the clicked chip can read "Copied".
 * Shared by the address chips in Settings → Mobile and the pairing dialog.
 */
import { ref } from 'vue';

export const COPIED_FLASH_MS = 1500;

export function useCopiedFlash() {
  const copied = ref<string | null>(null);

  function copy(text: string): void {
    void navigator.clipboard.writeText(text).then(() => {
      copied.value = text;
      setTimeout(() => { if (copied.value === text) copied.value = null; }, COPIED_FLASH_MS);
    });
  }

  return { copied, copy };
}
