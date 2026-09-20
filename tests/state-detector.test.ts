import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StateDetector } from '../src/session/state-detector';
import type { QuestionDetected, QuestionCleared, ActivityChange } from '../src/session/state-detector';

describe('StateDetector', () => {
  let detector: StateDetector;

  beforeEach(() => {
    detector = new StateDetector();
  });

  describe('initial state', () => {
    it('returns false for hasQuestion on unknown session', () => {
      expect(detector.hasQuestion('unknown')).toBe(false);
    });
  });

  describe('question detection', () => {
    it('sets questionPending on AIAGENT-QUESTION', () => {
      const handler = vi.fn();
      detector.on('question-detected', handler);

      detector.processOutput('s1', 'AIAGENT-QUESTION');

      expect(detector.hasQuestion('s1')).toBe(true);
      expect(handler).toHaveBeenCalledWith({ sessionId: 's1' } satisfies QuestionDetected);
    });


    it('clears questionPending when non-question output arrives', () => {
      const clearedHandler = vi.fn();
      detector.on('question-cleared', clearedHandler);

      detector.processOutput('s1', 'AIAGENT-QUESTION');
      expect(detector.hasQuestion('s1')).toBe(true);

      detector.processOutput('s1', 'normal output without keywords');

      expect(detector.hasQuestion('s1')).toBe(false);
      expect(clearedHandler).toHaveBeenCalledWith({ sessionId: 's1' } satisfies QuestionCleared);
    });

    it('does not clear questionPending if AIAGENT-QUESTION appears again', () => {
      const clearedHandler = vi.fn();
      detector.on('question-cleared', clearedHandler);

      detector.processOutput('s1', 'AIAGENT-QUESTION');
      detector.processOutput('s1', 'AIAGENT-QUESTION');

      expect(detector.hasQuestion('s1')).toBe(true);
      expect(clearedHandler).not.toHaveBeenCalled();
    });

    it('handles question + other text in same chunk', () => {
      detector.processOutput('s1', 'AIAGENT-QUESTION then some other text');

      expect(detector.hasQuestion('s1')).toBe(true);
    });
  });

  describe('session isolation', () => {
    it('tracks questions independently per session', () => {
      detector.processOutput('s1', 'AIAGENT-QUESTION');
      detector.processOutput('s2', 'normal output');

      expect(detector.hasQuestion('s1')).toBe(true);
      expect(detector.hasQuestion('s2')).toBe(false);
    });
  });

  describe('removeSession', () => {
    it('clears question state after removal', () => {
      detector.processOutput('s1', 'AIAGENT-QUESTION');
      detector.removeSession('s1');

      expect(detector.hasQuestion('s1')).toBe(false);
    });

    it('does not throw for unknown session', () => {
      expect(() => detector.removeSession('nonexistent')).not.toThrow();
    });
  });

  describe('activity tracking', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      detector.dispose();
      vi.useRealTimers();
    });

    it('processOutput updates lastOutputAt timestamp', () => {
      const startTime = Date.now();
      vi.setSystemTime(startTime);

      detector.processOutput('s1', 'some output');

      expect(detector.getLastOutputTime('s1')).toBe(startTime);
    });

    it('emits activity-change true on first output (inactive→active)', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.processOutput('s1', 'output that is definitely long enough to pass the threshold');

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 's1',
        level: 'active',
      }));
    });

    it('emits activity-change false after timeout expires (active→inactive)', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.processOutput('s1', 'output that is definitely long enough to pass the threshold');
      handler.mockClear();

      // Advance past the 10s default inactive timeout
      vi.advanceTimersByTime(10_001);

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 's1',
        level: 'inactive',
      }));
    });

    it('does not emit inactive before timeout expires', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.processOutput('s1', 'output that is definitely long enough to pass the threshold');
      handler.mockClear();

      vi.advanceTimersByTime(9_000);

      expect(handler).not.toHaveBeenCalled();
    });

    it('resets timer on rapid output — only one inactive event after final silence', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.processOutput('s1', 'output1 that is definitely long enough to pass the threshold');
      handler.mockClear();

      // Output every 5s — timer keeps resetting
      vi.advanceTimersByTime(5_000);
      detector.processOutput('s1', 'output2 that is definitely long enough to pass the threshold');

      vi.advanceTimersByTime(5_000);
      detector.processOutput('s1', 'output3 that is definitely long enough to pass the threshold');

      // No inactive events during rapid output
      expect(handler).not.toHaveBeenCalled();

      // Now go silent for 10s
      vi.advanceTimersByTime(10_001);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 's1',
        level: 'inactive',
      }));
    });

    it('re-emits active after inactive→active transition', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.processOutput('s1', 'output1 that is definitely long enough to pass the threshold');
      handler.mockClear();

      // Go inactive
      vi.advanceTimersByTime(10_001);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', level: 'inactive' }));
      handler.mockClear();

      // New output → active again
      detector.processOutput('s1', 'output2 that is definitely long enough to pass the threshold');
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', level: 'active' }));
    });

    it('does not emit duplicate active events for consecutive output', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.processOutput('s1', 'output1 that is definitely long enough to pass the threshold');
      detector.processOutput('s1', 'output2 that is definitely long enough to pass the threshold');
      detector.processOutput('s1', 'output3 that is definitely long enough to pass the threshold');

      // Only one active event on the first output
      const activeCalls = handler.mock.calls.filter(
        ([e]: [ActivityChange]) => e.sessionId === 's1' && e.level === 'active',
      );
      expect(activeCalls.length).toBe(1);
    });

    it('tracks multiple sessions independently', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.processOutput('s1', 'output1 that is definitely long enough to pass the threshold');
      vi.advanceTimersByTime(5_000);
      detector.processOutput('s2', 'output2 that is definitely long enough to pass the threshold');

      handler.mockClear();

      // s1 timeout fires at 10s from its last output (5s from now)
      vi.advanceTimersByTime(5_001);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', level: 'inactive' }));
      expect(handler).not.toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's2', level: 'inactive' }));

      handler.mockClear();

      // s2 timeout fires at 10s from its last output (5s later)
      vi.advanceTimersByTime(5_000);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's2', level: 'inactive' }));
    });

    it('removeSession clears the activity timer — no late events', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.processOutput('s1', 'output that is definitely long enough to pass the threshold');
      handler.mockClear();

      detector.removeSession('s1');

      // Timer should have been cleared — no inactive event
      vi.advanceTimersByTime(60_000);
      expect(handler).not.toHaveBeenCalled();
    });

    it('removeSession clears activity tracking data', () => {
      const startTime = Date.now();
      vi.setSystemTime(startTime);

      detector.processOutput('s1', 'output that is definitely long enough to pass the threshold');
      expect(detector.getLastOutputTime('s1')).toBe(startTime);

      detector.removeSession('s1');
      expect(detector.getLastOutputTime('s1')).toBe(0);
    });

    it('dispose clears all timers — no late events', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.processOutput('s1', 'output1 that is definitely long enough to pass the threshold');
      detector.processOutput('s2', 'output2 that is definitely long enough to pass the threshold');
      handler.mockClear();

      detector.dispose();

      vi.advanceTimersByTime(60_000);
      expect(handler).not.toHaveBeenCalled();
    });

    it('getLastOutputTime returns 0 for unknown session', () => {
      expect(detector.getLastOutputTime('unknown')).toBe(0);
    });

    it('respects custom timeout config via constructor', () => {
      const custom = new StateDetector({ inactiveMs: 5000, idleMs: 60000 });
      const handler = vi.fn();
      custom.on('activity-change', handler);

      custom.processOutput('s1', 'output that is definitely long enough to pass the threshold');
      handler.mockClear();

      // Not yet timed out at 4s
      vi.advanceTimersByTime(4_000);
      expect(handler).not.toHaveBeenCalled();

      // Times out at 5s → inactive
      vi.advanceTimersByTime(1_001);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', level: 'inactive' }));

      custom.dispose();
    });

    it('transitions to idle after idle timeout', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.processOutput('s1', 'output that is definitely long enough to pass the threshold');
      handler.mockClear();

      // At 10s → inactive
      vi.advanceTimersByTime(10_001);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', level: 'inactive' }));
      handler.mockClear();

      // At 5min → idle
      vi.advanceTimersByTime(300_000 - 10_001);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', level: 'idle' }));
    });

    it('does not emit idle if output resumes before idle timeout', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.processOutput('s1', 'output that is definitely long enough to pass the threshold');
      handler.mockClear();

      // Go inactive at 10s
      vi.advanceTimersByTime(10_001);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', level: 'inactive' }));
      handler.mockClear();

      // Resume output at 30s — back to active, idle timer cancelled
      vi.advanceTimersByTime(20_000);
      detector.processOutput('s1', 'more output that is definitely long enough to pass the threshold');
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', level: 'active' }));
      handler.mockClear();

      // Original idle timer would have fired, but was cancelled
      vi.advanceTimersByTime(300_000);
      // Should see inactive then idle from the new timers, not the old ones
      const idleCalls = handler.mock.calls.filter(([e]: [ActivityChange]) => e.level === 'idle');
      expect(idleCalls.length).toBe(1); // only from the new timer
    });
  });

  describe('markActive (input-triggered activity)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      detector.dispose();
      vi.useRealTimers();
    });

    it('transitions idle session to active on markActive', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.markActive('s1');

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', level: 'active' }));
    });

    it('transitions inactive session to active on markActive', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      // First make it active via output, then let it go inactive
      detector.processOutput('s1', 'output that is definitely long enough to pass the threshold');
      vi.advanceTimersByTime(10_001);
      handler.mockClear();

      detector.markActive('s1');

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', level: 'active' }));
    });

    it('does not emit duplicate active when already active', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.processOutput('s1', 'output that is definitely long enough to pass the threshold');
      handler.mockClear();

      detector.markActive('s1');

      expect(handler).not.toHaveBeenCalled();
    });

    it('resets inactivity timers so session stays active longer', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.processOutput('s1', 'output that is definitely long enough to pass the threshold');
      handler.mockClear();

      // At 8s, mark active (resets timers)
      vi.advanceTimersByTime(8_000);
      detector.markActive('s1');

      // Original inactive timer would fire at 10s (2s from now), but was reset
      vi.advanceTimersByTime(3_000);
      expect(handler).not.toHaveBeenCalled();

      // New inactive timer fires at 8s + 10s = 18s from start (7s from last advance)
      vi.advanceTimersByTime(7_001);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', level: 'inactive' }));
    });

    it('works after long idle period (idle → active)', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      // Make active then let go all the way to idle
      detector.processOutput('s1', 'output that is definitely long enough to pass the threshold');
      vi.advanceTimersByTime(300_001);
      handler.mockClear();

      // Now markActive from idle state
      detector.markActive('s1');

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', level: 'active' }));
    });
  });

  // -------------------------------------------------------------------------
  // Resize suppression — markResizing prevents activity promotion
  // -------------------------------------------------------------------------

  describe('resize suppression', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('skips activity promotion while resizing', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.markResizing('s1');
      detector.processOutput('s1', 'some resize redraw that is definitely long enough to pass the threshold');

      // Should NOT promote to active (no activity-change event for level promotion)
      expect(handler).not.toHaveBeenCalled();
    });

    it('still updates lastOutputAt while resizing', () => {
      detector.markResizing('s1');
      detector.processOutput('s1', 'some output');

      const lastOutput = detector.getLastOutputTime('s1');
      expect(lastOutput).toBeGreaterThan(0);
    });

    it('auto-clears resizing flag after 1 second', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.markResizing('s1');
      vi.advanceTimersByTime(1001);

      // Now activity promotion should work again
      detector.processOutput('s1', 'real output that is definitely long enough to pass the threshold');

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', level: 'active' }));
    });

    it('markActive clears the resizing flag', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.markResizing('s1');
      detector.processOutput('s1', 'output during resize that is definitely long enough to pass the threshold');
      // Should NOT promote (resizing suppresses activity promotion)
      expect(handler).not.toHaveBeenCalled();

      // markActive clears resizing flag and promotes to active
      detector.markActive('s1');
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', level: 'active' }));
    });

    it('resets auto-clear timer on repeated markResizing', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.markResizing('s1');
      vi.advanceTimersByTime(700);
      detector.markResizing('s1'); // refresh the timer
      vi.advanceTimersByTime(700); // 700ms since last markResizing (< 1000ms)

      // Still resizing — activity promotion suppressed
      detector.processOutput('s1', 'redraw output that is definitely long enough to pass the threshold');
      expect(handler).not.toHaveBeenCalled();

      vi.advanceTimersByTime(400); // now past the 1s window
      detector.processOutput('s1', 'real output that is definitely long enough to pass the threshold');
      expect(handler).toHaveBeenCalled();
    });

    it('removeSession clears resize timer', () => {
      detector.markResizing('s1');
      detector.removeSession('s1');

      // Should not throw or leave dangling timers
      vi.advanceTimersByTime(2000);
    });

    it('dispose clears all resize timers', () => {
      detector.markResizing('s1');
      detector.markResizing('s2');
      detector.dispose();

      vi.advanceTimersByTime(2000);
      // No errors, no state changes
    });

    it('promotes to active when suppression clears and output arrived during resize', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.markResizing('s1');
      detector.processOutput('s1', 'output during resize that is definitely long enough to pass the threshold');
      // Suppressed — no event
      expect(handler).not.toHaveBeenCalled();

      // Suppression clears after 1s → promoteIfRecentOutput fires
      vi.advanceTimersByTime(1001);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', level: 'active' }));
    });

    it('does not promote when suppression clears but no output during resize', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.markResizing('s1');
      // No processOutput call — no output arrived

      vi.advanceTimersByTime(1001);
      expect(handler).not.toHaveBeenCalled();
    });

    it('resets activity timers when suppression clears with recent output', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.markResizing('s1');
      detector.processOutput('s1', 'output during resize that is definitely long enough to pass the threshold');
      expect(handler).not.toHaveBeenCalled();

      // Suppression clears at 1s — promotes and resets timers
      vi.advanceTimersByTime(1001);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', level: 'active' }));
      handler.mockClear();

      // Inactive timer should fire 10s after suppression clear (not 10s from original output)
      vi.advanceTimersByTime(9_000);
      expect(handler).not.toHaveBeenCalled(); // not yet

      vi.advanceTimersByTime(1_100);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', level: 'inactive' }));
    });
  });

  // -------------------------------------------------------------------------
  // Switch/focus suppression — markSwitching prevents focus redraw activity
  // -------------------------------------------------------------------------

  describe('switch suppression', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('does not promote focus redraw output when switching clears', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.markSwitching('s1');
      detector.processOutput('s1', 'focus redraw output that is definitely long enough to pass the threshold');
      expect(handler).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1001);
      expect(handler).not.toHaveBeenCalled();
    });

    it('allows real output after switching clears to promote activity', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.markSwitching('s1');
      vi.advanceTimersByTime(1001);
      detector.processOutput('s1', 'real output that is definitely long enough to pass the threshold');

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', level: 'active' }));
    });

    it('markActive clears switching suppression', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.markSwitching('s1');
      detector.processOutput('s1', 'focus redraw output that is definitely long enough to pass the threshold');
      detector.markActive('s1');

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', level: 'active' }));
    });

    it('switch then resize does not falsely promote via promoteIfRecentOutput', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      // Simulate the real-world bug: switch triggers resize redraw
      detector.markSwitching('s1');
      detector.processOutput('s1', 'resize redraw prompt that is definitely long enough to pass the threshold');

      // Resize fires during switching window (fit() runs 2 rAF frames after switch)
      detector.markResizing('s1');

      // Switching clears at 1s — does NOT call promoteIfRecentOutput
      vi.advanceTimersByTime(1001);

      // Resizing clears at 1s — calls promoteIfRecentOutput, but lastOutputAt
      // was NOT updated during switching, so there's no "recent" output to promote
      vi.advanceTimersByTime(1);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Scroll suppression — markScrolling prevents marker scanning
  // -------------------------------------------------------------------------

  describe('scroll suppression', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      detector.dispose();
      vi.useRealTimers();
    });

    it('skips question detection while scrolling', () => {
      const handler = vi.fn();
      detector.on('question-detected', handler);

      detector.markScrolling('s1');
      detector.processOutput('s1', 'AIAGENT-QUESTION');

      // Marker scanning suppressed — no question detected
      expect(handler).not.toHaveBeenCalled();
    });

    it('still promotes activity while scrolling', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.markScrolling('s1');
      detector.processOutput('s1', 'some scroll output that is definitely long enough to pass the threshold');

      // Activity promotion is NOT suppressed by scrolling (only resizing suppresses it)
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', level: 'active' }));
    });

    it('still updates lastOutputAt while scrolling', () => {
      detector.markScrolling('s1');
      detector.processOutput('s1', 'scroll output');

      expect(detector.getLastOutputTime('s1')).toBeGreaterThan(0);
    });

    it('auto-clears scrolling flag after 2 seconds', () => {
      const handler = vi.fn();
      detector.on('question-detected', handler);

      detector.markScrolling('s1');
      vi.advanceTimersByTime(2001);

      // Question detection resumes after scrolling clears
      detector.processOutput('s1', 'AIAGENT-QUESTION');
      expect(handler).toHaveBeenCalledWith({ sessionId: 's1' });
    });

    it('markActive clears the scrolling flag', () => {
      const questionHandler = vi.fn();
      detector.on('question-detected', questionHandler);

      detector.markScrolling('s1');
      detector.processOutput('s1', 'AIAGENT-QUESTION');
      expect(questionHandler).not.toHaveBeenCalled();

      // markActive clears scrolling — question detection resumes
      detector.markActive('s1');
      detector.processOutput('s1', 'AIAGENT-QUESTION');
      expect(questionHandler).toHaveBeenCalledWith({ sessionId: 's1' });
    });

    it('resets auto-clear timer on repeated markScrolling', () => {
      const questionHandler = vi.fn();
      detector.on('question-detected', questionHandler);

      detector.markScrolling('s1');
      vi.advanceTimersByTime(1500);
      detector.markScrolling('s1'); // refresh the timer
      vi.advanceTimersByTime(1500); // 1.5s since last markScrolling (< 2s)

      // Still scrolling — question detection suppressed
      detector.processOutput('s1', 'AIAGENT-QUESTION');
      expect(questionHandler).not.toHaveBeenCalled();

      vi.advanceTimersByTime(600); // now past the 2s window
      detector.processOutput('s1', 'AIAGENT-QUESTION');
      expect(questionHandler).toHaveBeenCalledWith({ sessionId: 's1' });
    });

    it('removeSession clears scroll timer', () => {
      detector.markScrolling('s1');
      detector.removeSession('s1');

      vi.advanceTimersByTime(3000);
    });

    it('dispose clears all scroll timers', () => {
      detector.markScrolling('s1');
      detector.markScrolling('s2');
      detector.dispose();

      vi.advanceTimersByTime(3000);
      // No errors, no state changes
    });
  });

  // -------------------------------------------------------------------------
  // Restore suppression — markRestored prevents activity promotion for 3s
  // -------------------------------------------------------------------------

  describe('restore suppression', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      detector.dispose();
      vi.useRealTimers();
    });

    it('skips activity promotion while restoring', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.markRestored('s1');
      detector.processOutput('s1', 'shell startup output that is definitely long enough to pass the threshold');

      // Should NOT promote to active (restoring suppresses activity promotion)
      expect(handler).not.toHaveBeenCalled();
    });

    it('still updates lastOutputAt while restoring', () => {
      detector.markRestored('s1');
      detector.processOutput('s1', 'startup output');

      expect(detector.getLastOutputTime('s1')).toBeGreaterThan(0);
    });

    it('auto-clears restoring flag after 3 seconds', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.markRestored('s1');
      vi.advanceTimersByTime(3001);

      // Activity promotion works again
      detector.processOutput('s1', 'real output that is definitely long enough to pass the threshold');
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', level: 'active' }));
    });

    it('markActive clears the restoring flag', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.markRestored('s1');
      detector.processOutput('s1', 'startup output that is definitely long enough to pass the threshold');
      expect(handler).not.toHaveBeenCalled();

      // markActive clears restoring flag and promotes to active
      detector.markActive('s1');
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', level: 'active' }));
    });

    it('promotes to active when restore grace period clears and output arrived', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.markRestored('s1');
      detector.processOutput('s1', 'startup output during restore that is definitely long enough to pass the threshold');
      expect(handler).not.toHaveBeenCalled();

      // Grace period clears after 3s → promoteIfRecentOutput fires
      vi.advanceTimersByTime(3001);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', level: 'active' }));
    });

    it('does not promote when restore grace clears but no output arrived', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.markRestored('s1');
      // No processOutput call

      vi.advanceTimersByTime(3001);
      expect(handler).not.toHaveBeenCalled();
    });

    it('removeSession clears restore timer', () => {
      detector.markRestored('s1');
      detector.removeSession('s1');

      vi.advanceTimersByTime(5000);
    });

    it('dispose clears all restore timers', () => {
      detector.markRestored('s1');
      detector.markRestored('s2');
      detector.dispose();

      vi.advanceTimersByTime(5000);
      // No errors, no state changes
    });
  });

  // -------------------------------------------------------------------------
  // lastOutputAt in activity-change events
  // -------------------------------------------------------------------------

  describe('lastOutputAt in activity-change events', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      detector.dispose();
      vi.useRealTimers();
    });

    it('includes lastOutputAt in active event from processOutput', () => {
      const startTime = Date.now();
      vi.setSystemTime(startTime);
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.processOutput('s1', 'output that is definitely long enough to pass the threshold');

      expect(handler).toHaveBeenCalledWith({
        sessionId: 's1',
        level: 'active',
        lastOutputAt: startTime,
      });
    });

    it('includes lastOutputAt in inactive event from timer', () => {
      const startTime = Date.now();
      vi.setSystemTime(startTime);
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.processOutput('s1', 'output that is definitely long enough to pass the threshold');
      handler.mockClear();

      vi.advanceTimersByTime(10_001);

      expect(handler).toHaveBeenCalledWith({
        sessionId: 's1',
        level: 'inactive',
        lastOutputAt: startTime,
      });
    });

    it('includes lastOutputAt in idle event from timer', () => {
      const startTime = Date.now();
      vi.setSystemTime(startTime);
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.processOutput('s1', 'output that is definitely long enough to pass the threshold');
      handler.mockClear();

      vi.advanceTimersByTime(300_001);

      const idleCall = handler.mock.calls.find(([e]: [ActivityChange]) => e.level === 'idle');
      expect(idleCall).toBeDefined();
      expect(idleCall![0].lastOutputAt).toBe(startTime);
    });

    it('includes lastOutputAt in markActive event (preserves previous output time)', () => {
      const startTime = Date.now();
      vi.setSystemTime(startTime);

      // Create some output first
      detector.processOutput('s1', 'output that is definitely long enough to pass the threshold');
      vi.advanceTimersByTime(10_001); // go inactive

      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.markActive('s1');

      expect(handler).toHaveBeenCalledWith({
        sessionId: 's1',
        level: 'active',
        lastOutputAt: startTime,
      });
    });

    it('markActive on fresh session initializes lastOutputAt to now', () => {
      const now = Date.now();
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.markActive('s1');

      expect(handler).toHaveBeenCalledWith({
        sessionId: 's1',
        level: 'active',
        lastOutputAt: now,
      });
    });

    it('includes updated lastOutputAt after multiple outputs', () => {
      const t0 = Date.now();
      vi.setSystemTime(t0);
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.processOutput('s1', 'first output that is definitely long enough to pass the threshold');
      handler.mockClear();

      // Advance 5s and produce more output
      const t1 = t0 + 5_000;
      vi.setSystemTime(t1);
      vi.advanceTimersByTime(5_000);

      // Go inactive after 10s from last output
      vi.advanceTimersByTime(10_001);

      expect(handler).toHaveBeenCalledWith({
        sessionId: 's1',
        level: 'inactive',
        lastOutputAt: t0, // no new output happened, lastOutputAt unchanged
      });
    });
  });

  // -------------------------------------------------------------------------
  // Activity debounce — small output chunks are debounced to filter TUI noise
  // -------------------------------------------------------------------------

  describe('activity debounce', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      detector.dispose();
      vi.useRealTimers();
    });

    it('immediately promotes large output chunks to active', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.processOutput('s1', 'this is a large chunk of output that exceeds the threshold');

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', level: 'active' }));
    });

    it('debounces small output chunks (no immediate promotion)', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.processOutput('s1', 'tiny');

      // Should NOT immediately promote — debounce timer is running
      expect(handler).not.toHaveBeenCalled();
    });

    it('promotes after debounce window passes with no new small chunks', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.processOutput('s1', 'tiny');
      vi.advanceTimersByTime(150); // debounce window

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', level: 'active' }));
    });

    it('resets debounce timer on consecutive small chunks', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.processOutput('s1', 'tiny1');
      vi.advanceTimersByTime(100);
      detector.processOutput('s1', 'tiny2');
      vi.advanceTimersByTime(100);

      // Still within debounce window after second chunk
      expect(handler).not.toHaveBeenCalled();

      vi.advanceTimersByTime(150); // 250ms from second chunk
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', level: 'active' }));
    });

    it('resets activity timers when already active (large chunks)', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.processOutput('s1', 'large chunk that exceeds the threshold for immediate promotion');
      handler.mockClear();

      vi.advanceTimersByTime(8_000);
      detector.processOutput('s1', 'another large chunk that exceeds the threshold');

      // Should NOT emit activity-change (already active), but resets timers
      expect(handler).not.toHaveBeenCalled();

      // Inactive timer should fire 10s from this new output, not from original
      vi.advanceTimersByTime(3_000);
      expect(handler).not.toHaveBeenCalled();

      vi.advanceTimersByTime(7_001);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', level: 'inactive' }));
    });

    it('debounces timer resets when already active (small chunks)', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      // First promote to active with large chunk
      detector.processOutput('s1', 'large chunk that exceeds the threshold for immediate promotion');
      handler.mockClear();

      vi.advanceTimersByTime(8_000);
      detector.processOutput('s1', 'tiny');

      // Should NOT emit activity-change or reset timers until the debounce settles
      expect(handler).not.toHaveBeenCalled();

      vi.advanceTimersByTime(149);
      vi.advanceTimersByTime(1);
      expect(handler).not.toHaveBeenCalled();

      vi.advanceTimersByTime(9_999);
      expect(handler).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', level: 'inactive' }));
    });

    it('does not let continuous small chunks keep an active session green', () => {
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.processOutput('s1', 'large chunk that exceeds the threshold for immediate promotion');
      handler.mockClear();

      for (let elapsed = 0; elapsed < 10_000; elapsed += 100) {
        vi.advanceTimersByTime(100);
        detector.processOutput('s1', 'tick');
      }

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', level: 'inactive' }));
    });

    it('removeSession clears debounce timer', () => {
      detector.processOutput('s1', 'tiny');
      detector.removeSession('s1');

      vi.advanceTimersByTime(500);
      // No errors, no state changes
    });

    it('dispose clears all debounce timers', () => {
      detector.processOutput('s1', 'tiny1');
      detector.processOutput('s2', 'tiny2');
      detector.dispose();

      vi.advanceTimersByTime(500);
      // No errors, no state changes
    });
  });

  describe('hook-reported activity (G3 second producer)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('markHookWorking promotes to active with the same activity-change contract as PTY output', () => {
      vi.useFakeTimers();
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.markHookWorking('s1');

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 's1', level: 'active' }),
      );
    });

    it('markHookTurnEnded leaves green immediately, without waiting out the silence timer', () => {
      vi.useFakeTimers();
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.markHookWorking('s1');
      handler.mockClear();

      // Zero elapsed time — the drop comes from the Stop hook, not a timer.
      detector.markHookTurnEnded('s1');

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 's1', level: 'inactive' }),
      );
    });

    it('markHookTurnEnded restarts the idle countdown from the turn end', () => {
      vi.useFakeTimers();
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.markHookWorking('s1');
      vi.advanceTimersByTime(120_000); // two minutes of pre-turn silence decay timers
      detector.markHookTurnEnded('s1');

      handler.mockClear();
      vi.advanceTimersByTime(299_999);
      expect(handler).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 's1', level: 'idle' }),
      );
    });

    it('markHookTurnEnded emits nothing when already inactive', () => {
      vi.useFakeTimers();
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.markHookWorking('s1');
      detector.markHookTurnEnded('s1');
      handler.mockClear();

      detector.markHookTurnEnded('s1');
      expect(handler).not.toHaveBeenCalled();
    });

    it('PTY output still promotes after a hook turn end — hooks going silent cannot stick the dot', () => {
      vi.useFakeTimers();
      const handler = vi.fn();
      detector.on('activity-change', handler);

      detector.markHookTurnEnded('s1');
      handler.mockClear();

      detector.processOutput('s1', 'a genuinely large chunk of fresh terminal output');
      vi.advanceTimersByTime(200); // past the small-chunk debounce, well under 10s

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 's1', level: 'active' }),
      );
    });
  });
});
