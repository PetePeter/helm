/**
 * useScratchpad: the renderer mirror of one session's scratchpad.
 *
 * Main owns the pad (ScratchpadManager); this keeps the pane's text in step
 * with it in both directions. The user's edits are saved after a short pause,
 * each naming the revision it was based on. An edit from elsewhere (the
 * session's LLM, or the same session in another window) replaces the text when
 * the user has nothing unsaved; when they do, nothing is overwritten on either
 * side and `conflict` asks the user to pick. See docs/scratchpad.md.
 */

import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { eventsClient, sessionsClient } from '../ipc/clients.js';
import { scratchpadBytes, type Scratchpad } from '../../src/types/scratchpad.js';

export const SCRATCHPAD_SAVE_DELAY_MS = 400;

/** One session's sync state. The composable's refs are a view of the one on screen. */
interface Sync {
  sessionId: string;
  /** The pad as main last reported it. Revision -1 until the first load. */
  pad: Scratchpad;
  /** What the user has in the editor for this session. */
  draft: string;
  /** Someone else changed the pad under unsaved typing. Nothing is saved until the user picks. */
  conflict: boolean;
  /** Why the last save did not go through (too large, session gone). */
  error: string;
  /** Text of the save in flight: how this window's own change event is told from someone else's. */
  sending: string | null;
  /** Resolves when every queued load and save is done; they chain on it so they never overlap. */
  idle: Promise<void>;
}

/**
 * Every session with something still in play in this window: on screen, a save
 * in flight, or typing that could not be saved (an open conflict, an over-size
 * pad). Keeping the state by session, not by pane, is what lets the user switch
 * session or close the pane without losing that typing, and lets a late save or
 * change event land on the session it belongs to. An entry is dropped once the
 * session is off screen with nothing unsaved. It does not outlive the window.
 */
const syncs = new Map<string, Sync>();

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const isDirty = (target: Sync): boolean => target.draft !== target.pad.text;
const isOwnWrite = (target: Sync, next: Scratchpad): boolean =>
  next.updatedBy === 'user' && target.sending === next.text;

export function useScratchpad(sessionId: () => string | null) {
  const text = ref('');
  /** The pad as main last reported it; null while it loads. */
  const pad = ref<Scratchpad | null>(null);
  const conflict = ref(false);
  const error = ref('');

  let sync: Sync | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const loading = computed(() => pad.value === null);
  const dirty = computed(() => pad.value !== null && text.value !== pad.value.text);
  const bytes = computed(() => scratchpadBytes(text.value));

  /** Push one session's state to the refs, if it is the one on screen. */
  function show(target: Sync): void {
    if (target !== sync) return;
    pad.value = target.pad.revision < 0 ? null : target.pad;
    text.value = target.draft;
    conflict.value = target.conflict;
    error.value = target.error;
  }

  /**
   * Take a pad reported by main, unless it is older than what is already known.
   * A clean editor follows it. Unsaved typing stays, and becomes a conflict when
   * the pad really moved and the move was not this window's own save.
   */
  function adopt(target: Sync, next: Scratchpad): void {
    if (next.revision < target.pad.revision) return;
    const moved = next.revision > target.pad.revision;
    const wasClean = !isDirty(target);
    const own = isOwnWrite(target, next);
    target.pad = next;
    if (wasClean) target.draft = next.text;
    else if (moved && !own) target.conflict = true;
    if (!isDirty(target)) target.conflict = false;
    show(target);
  }

  async function send(target: Sync): Promise<void> {
    // Decided when the save actually starts, not when it was queued: a conflict
    // found by the save before this one must stop this one too.
    if (target.conflict || !isDirty(target)) return;
    target.sending = target.draft;
    try {
      const result = await sessionsClient.scratchpadSet(target.sessionId, target.sending, target.pad.revision);
      target.error = result.ok || result.reason === 'stale' ? '' : result.message;
      // A too-large refusal changed nothing in main: there is no newer pad to take.
      if (result.ok || result.reason === 'stale') adopt(target, result.scratchpad);
    } catch (err) {
      target.error = message(err);
    } finally {
      target.sending = null;
    }
    show(target);
    if (target === sync && !target.error && !target.conflict && isDirty(target)) schedule(); // typed on meanwhile
  }

  async function load(target: Sync): Promise<void> {
    try {
      adopt(target, await sessionsClient.scratchpadGet(target.sessionId));
    } catch (err) {
      target.error = message(err);
      show(target);
    }
  }

  function cancelTimer(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function schedule(): void {
    cancelTimer();
    timer = setTimeout(() => { void flush(); }, SCRATCHPAD_SAVE_DELAY_MS);
  }

  /** Save what is typed now (queued behind anything already in flight). */
  function flush(): Promise<void> {
    cancelTimer();
    const target = sync;
    if (!target) return Promise.resolve();
    target.idle = target.idle.then(() => send(target));
    return target.idle;
  }

  function edit(value: string): void {
    if (!sync) return;
    sync.draft = value;
    sync.error = '';
    show(sync);
    if (!sync.conflict) schedule();
  }

  /** The user's text wins: written over the other edit, on purpose. */
  function keepMine(): Promise<void> {
    if (sync) {
      sync.conflict = false;
      show(sync);
    }
    return flush();
  }

  function takeTheirs(): void {
    if (!sync) return;
    sync.draft = sync.pad.text;
    sync.conflict = false;
    show(sync);
  }

  /**
   * The session goes off screen (switch, pane closed): save what can be saved.
   * Its state is forgotten only when nothing unsaved is left in it.
   */
  function leave(): void {
    const target = sync;
    if (!target) return;
    void flush().then(() => {
      if (target !== sync && !isDirty(target) && syncs.get(target.sessionId) === target) syncs.delete(target.sessionId);
    });
    sync = null;
  }

  const stopListening = eventsClient.onScratchpadChanged?.((next) => {
    const target = syncs.get(next.sessionId);
    if (target && next.revision > target.pad.revision) adopt(target, next);
  });

  watch(sessionId, (id) => {
    leave();
    pad.value = null;
    text.value = '';
    conflict.value = false;
    error.value = '';
    if (!id) return;
    // Revision -1: anything main reports, a change event included, is newer than "not loaded".
    const target: Sync = syncs.get(id) ?? {
      sessionId: id,
      pad: { sessionId: id, text: '', revision: -1 },
      draft: '',
      conflict: false,
      error: '',
      sending: null,
      idle: Promise.resolve(),
    };
    syncs.set(id, target);
    sync = target;
    show(target);
    // Behind any save still in flight for this session, so the read reflects it.
    target.idle = target.idle.then(() => load(target));
  }, { immediate: true });

  onBeforeUnmount(() => {
    leave();
    stopListening?.();
  });

  return { text, pad, loading, dirty, conflict, error, bytes, edit, flush, keepMine, takeTheirs };
}
