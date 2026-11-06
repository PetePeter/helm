/**
 * session-alert — the shared definition of "something happened".
 *
 * These assertions are the contract between two transports that must never
 * diverge: TelegramNotifier and MobileAlertNotifier both gate on this, so a
 * change here is a change to what BOTH surfaces tell the user.
 */

import { describe, it, expect } from 'vitest';
import { alertKindForTransition, alertText } from '../src/session/session-alert';

describe('alertKindForTransition', () => {
  it('fires once when a working session stops working (turn ended)', () => {
    expect(alertKindForTransition('active', 'inactive')).toBe('completion');
    expect(alertKindForTransition('active', 'idle')).toBe('completion');
  });

  it('stays silent while the session is still working or was already stopped', () => {
    expect(alertKindForTransition('active', 'active')).toBeNull();
    expect(alertKindForTransition('inactive', 'idle')).toBeNull();
    expect(alertKindForTransition('idle', 'active')).toBeNull();
  });

  it('stays silent when either end of the transition is unknown', () => {
    expect(alertKindForTransition(undefined, 'inactive')).toBeNull();
    expect(alertKindForTransition('active', undefined)).toBeNull();
  });

  it('has a body for the kind it returns', () => {
    expect(alertText(alertKindForTransition('active', 'inactive')!)).toBeTruthy();
  });
});
