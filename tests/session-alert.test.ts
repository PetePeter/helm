/**
 * session-alert — the shared definition of "something happened".
 *
 * These assertions are the contract between two transports that must never
 * diverge: TelegramNotifier and MobileAlertNotifier both gate on this, so a
 * change here is a change to what BOTH surfaces tell the user.
 */

import { describe, it, expect } from 'vitest';
import { alertKindForTransition, alertText } from '../src/session/session-alert';
import type { SessionState } from '../src/types/session';

describe('alertKindForTransition', () => {
  it('fires only when a working session stops working', () => {
    expect(alertKindForTransition('implementing', 'completed')).toBe('completion');
    expect(alertKindForTransition('planning', 'idle')).toBe('idle');
    expect(alertKindForTransition('implementing', 'waiting')).toBe('attention');
  });

  it('stays silent while the session is still working', () => {
    expect(alertKindForTransition('planning', 'implementing')).toBeNull();
    expect(alertKindForTransition('implementing', 'planning')).toBeNull();
  });

  it('stays silent when the session was already stopped', () => {
    // Otherwise every unrelated field update on a finished session would buzz.
    expect(alertKindForTransition('idle', 'completed')).toBeNull();
    expect(alertKindForTransition('completed', 'waiting')).toBeNull();
  });

  it('stays silent when either end of the transition is unknown', () => {
    expect(alertKindForTransition(undefined, 'completed')).toBeNull();
    expect(alertKindForTransition('implementing', undefined)).toBeNull();
  });

  it('has a body for every kind it can return', () => {
    const states: SessionState[] = ['completed', 'idle', 'waiting'];
    for (const state of states) {
      const kind = alertKindForTransition('implementing', state);
      expect(kind).not.toBeNull();
      expect(alertText(kind!)).toBeTruthy();
    }
  });
});
