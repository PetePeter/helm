/** Batch keydown events by session and five-minute slot without retaining key content. */
const SLOT_MS = 5 * 60_000;
const FLUSH_MS = 5_000;

export type KeypressTarget = string | { dirPath: string };

export function createKeypressCounter(
  send: (target: KeypressTarget, count: number, at: number) => void,
  now: () => number = Date.now,
) {
  const pending = new Map<string, { target: KeypressTarget; count: number; at: number }>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush(): void {
    if (timer) { clearTimeout(timer); timer = null; }
    for (const batch of pending.values()) send(batch.target, batch.count, batch.at);
    pending.clear();
  }

  function record(target: KeypressTarget | null, event: KeyboardEvent): void {
    if (!target || event.repeat) return;
    const at = now();
    const key = JSON.stringify([target, Math.floor(at / SLOT_MS)]);
    const batch = pending.get(key);
    if (batch) batch.count++;
    else pending.set(key, { target, count: 1, at });
    timer ??= setTimeout(flush, FLUSH_MS);
  }

  return { record, flush };
}
