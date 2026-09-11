/**
 * MobileAlertNotifier — when a session change becomes a buzz in your pocket.
 *
 * The sink is a recorder rather than a mock: what is worth asserting is which
 * alerts a phone would END UP with, and a verify() per call would say the method
 * ran without ever saying what the user was told. The transition rules are the
 * substance here — an alert for something that did not happen is worse than a
 * missing one, because it teaches the user to ignore the channel.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MobileAlertNotifier, FLASH_ALERT_TEXT } from '../src/mobile/mobile-alert-notifier';
import type { SessionAlertKind } from '../src/session/session-alert';

class RecordingSink {
  readonly alerts: Array<{ sessionId: string; kind: SessionAlertKind; text: string }> = [];
  carried = true;

  sendAlert(sessionId: string, kind: SessionAlertKind, text: string): boolean {
    this.alerts.push({ sessionId, kind, text });
    return this.carried;
  }
}

let sink: RecordingSink;
let notifier: MobileAlertNotifier;

beforeEach(() => {
  sink = new RecordingSink();
  notifier = new MobileAlertNotifier(sink);
});

describe('MobileAlertNotifier', () => {
  it('alerts when a working session stops working', () => {
    notifier.observe({ id: 's1', aiagentState: 'implementing' });
    notifier.observe({ id: 's1', aiagentState: 'completed' });

    expect(sink.alerts).toEqual([{ sessionId: 's1', kind: 'completion', text: 'Finished' }]);
  });

  it('maps each stopping state to the channel that can be silenced for it', () => {
    for (const [id, state] of [['s1', 'completed'], ['s2', 'idle'], ['s3', 'waiting']] as const) {
      notifier.observe({ id, aiagentState: 'implementing' });
      notifier.observe({ id, aiagentState: state });
    }

    expect(sink.alerts.map(alert => alert.kind)).toEqual(['completion', 'idle', 'attention']);
  });

  it('says nothing while a session is still working', () => {
    notifier.observe({ id: 's1', aiagentState: 'planning' });
    notifier.observe({ id: 's1', aiagentState: 'implementing' });
    notifier.observe({ id: 's1', aiagentState: 'planning' });

    expect(sink.alerts).toEqual([]);
  });

  it('does not re-alert while a session stays stopped', () => {
    // session:updated fires for every field, not only this one. Re-alerting on
    // a rename would buzz the phone about something that did not happen.
    notifier.observe({ id: 's1', aiagentState: 'implementing' });
    notifier.observe({ id: 's1', aiagentState: 'idle' });
    notifier.observe({ id: 's1', aiagentState: 'idle' });
    notifier.observe({ id: 's1', aiagentState: 'idle' });

    expect(sink.alerts).toHaveLength(1);
  });

  it('never alerts on the first sighting of a session', () => {
    // A session restored at startup arrives already completed. Announcing it
    // would buzz the phone for work that finished before the app was running.
    notifier.observe({ id: 's1', aiagentState: 'completed' });

    expect(sink.alerts).toEqual([]);
  });

  it('forgets a closed session so a reused id cannot transition from a ghost', () => {
    notifier.observe({ id: 's1', aiagentState: 'implementing' });
    notifier.forget('s1');

    notifier.observe({ id: 's1', aiagentState: 'completed' });

    expect(sink.alerts).toEqual([]);
  });

  it('alerts again after the session goes back to work', () => {
    notifier.observe({ id: 's1', aiagentState: 'implementing' });
    notifier.observe({ id: 's1', aiagentState: 'completed' });
    notifier.observe({ id: 's1', aiagentState: 'implementing' });
    notifier.observe({ id: 's1', aiagentState: 'completed' });

    expect(sink.alerts).toHaveLength(2);
  });

  it('pushes notify_user as the agent wrote it', () => {
    notifier.notified('s1', 'Session Needs Attention', 'Which branch should I target?');

    expect(sink.alerts).toEqual([
      { sessionId: 's1', kind: 'attention', text: 'Which branch should I target?' },
    ]);
  });

  it('pushes a flash with a body, since a flash carries no text of its own', () => {
    notifier.flashed('s1');

    expect(sink.alerts).toEqual([{ sessionId: 's1', kind: 'attention', text: FLASH_ALERT_TEXT }]);
  });

  it('does not retry an alert the link could not carry', () => {
    sink.carried = false;
    notifier.flashed('s1');
    sink.carried = true;

    // An alert is only true when it happens; a queue would deliver "needs input"
    // about something that finished an hour ago.
    expect(sink.alerts).toHaveLength(1);
  });

  it('survives a sink that throws, because an alert must not break its trigger', () => {
    const exploding = new MobileAlertNotifier({
      sendAlert: () => {
        throw new Error('the radio is gone');
      },
    });

    expect(() => exploding.flashed('s1')).not.toThrow();
  });
});
