import type { SessionInfo } from '../types/session.js';

/** Throw when the session is frozen — every programmatic sender checks this first. */
export function assertSessionWritable(session: Pick<SessionInfo, 'name' | 'frozen'>): void {
  if (session.frozen) throw new Error(`Session "${session.name}" is frozen — it accepts no input until the user unfreezes it`);
}
