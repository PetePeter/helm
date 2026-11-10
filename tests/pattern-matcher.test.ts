import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { compileCaseInsensitiveRegex, findRegexMatch, PatternMatcher, stripAnsiSequences } from '../src/session/pattern-matcher.js';
import type { PatternRule } from '../src/config/loader.js';

// ============================================================================
// Helpers
// ============================================================================

function makeRule(overrides: Partial<PatternRule> = {}): PatternRule {
  return {
    regex: 'rate limit',
    action: 'send-text',
    sequence: 'retry{Enter}',
    cooldownMs: 300_000,
    ...overrides,
  } as PatternRule;
}

function makeWaitRule(overrides: Partial<PatternRule> = {}): PatternRule {
  return {
    regex: 'try again at (\\d{1,2}(?::\\d{2})?(?:am|pm))',
    action: 'wait-until',
    timeGroup: 1,
    onResume: '/resume{Enter}',
    cooldownMs: 300_000,
    ...overrides,
  } as PatternRule;
}

function makeMatcher(rules: PatternRule[] = []) {
  const writes: [string, string][] = [];
  const ptyWrite = vi.fn((sid: string, data: string) => { writes.push([sid, data]); });
  const getPatterns = vi.fn((_cliType: string) => rules);
  const pm = new PatternMatcher(ptyWrite, getPatterns);
  return { pm, ptyWrite, getPatterns, writes };
}

// ============================================================================
// Tests
// ============================================================================

describe('PatternMatcher', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

  it('shares ANSI stripping and case-insensitive matching helpers', () => {
    const regex = compileCaseInsensitiveRegex('TRUST\\s+THIS');
    expect(stripAnsiSequences('\x1b[33mTrust this\x1b[0m')).toBe('Trust this');
    expect(regex && findRegexMatch('Trust this', regex)?.[0]).toBe('Trust this');
    expect(compileCaseInsensitiveRegex('[invalid(')).toBeNull();
  });

  describe('send-text', () => {
    it('calls ptyWrite immediately on match', () => {
      const { pm, ptyWrite } = makeMatcher([makeRule()]);
      pm.processOutput('s1', 'claude-code', 'we hit the rate limit now');
      // Sequence 'retry{Enter}' is parsed: text 'retry' + key 'Enter' (\r)
      expect(ptyWrite).toHaveBeenCalledWith('s1', 'retry\r');
    });

    it('does not fire when pattern does not match', () => {
      const { pm, ptyWrite } = makeMatcher([makeRule()]);
      pm.processOutput('s1', 'claude-code', 'all good');
      expect(ptyWrite).not.toHaveBeenCalled();
    });

    it('emits "pattern-matched" event', () => {
      const { pm } = makeMatcher([makeRule()]);
      const handler = vi.fn();
      pm.on('pattern-matched', handler);
      pm.processOutput('s1', 'claude-code', 'we hit the rate limit now');
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 's1', cliType: 'claude-code', ruleIndex: 0,
      }));
    });

    it('respects cooldown — does not fire again within window', () => {
      const { pm, ptyWrite } = makeMatcher([makeRule({ cooldownMs: 5_000 })]);
      pm.processOutput('s1', 'claude-code', 'rate limit');
      pm.processOutput('s1', 'claude-code', 'rate limit again');
      expect(ptyWrite).toHaveBeenCalledTimes(1);
    });

    it('fires again after cooldown expires', () => {
      const { pm, ptyWrite } = makeMatcher([makeRule({ cooldownMs: 5_000 })]);
      pm.processOutput('s1', 'claude-code', 'rate limit');
      vi.advanceTimersByTime(6_000);
      pm.processOutput('s1', 'claude-code', 'rate limit');
      expect(ptyWrite).toHaveBeenCalledTimes(2);
    });

    it('cooldown is per-session — different sessions fire independently', () => {
      const { pm, ptyWrite } = makeMatcher([makeRule({ cooldownMs: 5_000 })]);
      pm.processOutput('s1', 'claude-code', 'rate limit');
      pm.processOutput('s2', 'claude-code', 'rate limit');
      expect(ptyWrite).toHaveBeenCalledTimes(2);
    });

    it('handles invalid regex gracefully', () => {
      const { pm, ptyWrite } = makeMatcher([makeRule({ regex: '[invalid(' })]);
      expect(() => pm.processOutput('s1', 'claude-code', 'test')).not.toThrow();
      expect(ptyWrite).not.toHaveBeenCalled();
    });

    it('strips ANSI escape sequences before matching', () => {
      // Real terminal output wraps text in colour codes — pattern must still match
      const { pm, ptyWrite } = makeMatcher([makeRule()]);
      const ansiDecorated = '\x1b[31mwe hit the rate limit now\x1b[0m';
      pm.processOutput('s1', 'claude-code', ansiDecorated);
      expect(ptyWrite).toHaveBeenCalledWith('s1', 'retry\r');
    });

    it('strips OSC title sequences before matching', () => {
      const { pm, ptyWrite } = makeMatcher([makeRule()]);
      const withOsc = '\x1b]0;terminal title\x07rate limit detected';
      pm.processOutput('s1', 'claude-code', withOsc);
      expect(ptyWrite).toHaveBeenCalledWith('s1', 'retry\r');
    });
  });

  describe('wait-until with timeGroup', () => {
    it('emits schedule-created when pattern matches', () => {
      const { pm } = makeMatcher([makeWaitRule()]);
      const handler = vi.fn();
      pm.on('schedule-created', handler);
      pm.processOutput('s1', 'claude-code', 'try again at 9pm');
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 's1', ruleIndex: 0,
      }));
    });

    it('fires onResume sequence at scheduled time', () => {
      const { pm, ptyWrite } = makeMatcher([makeWaitRule()]);
      pm.processOutput('s1', 'claude-code', 'try again at 9pm');
      vi.runAllTimers();
      // Sequence 'onResume' is parsed: text '/resume' + key 'Enter' (\r)
      expect(ptyWrite).toHaveBeenCalledWith('s1', '/resume\r');
    });

    it('emits schedule-fired after timer fires', () => {
      const { pm } = makeMatcher([makeWaitRule()]);
      const handler = vi.fn();
      pm.on('schedule-fired', handler);
      pm.processOutput('s1', 'claude-code', 'try again at 9pm');
      vi.runAllTimers();
      expect(handler).toHaveBeenCalledWith({ sessionId: 's1' });
    });

    it('new schedule replaces existing for same session', () => {
      // Use cooldownMs: 0 so the second processOutput also passes the cooldown check
      const { pm } = makeMatcher([makeWaitRule({ cooldownMs: 0 })]);
      const handler = vi.fn();
      pm.on('schedule-created', handler);
      pm.processOutput('s1', 'claude-code', 'try again at 9pm');
      pm.processOutput('s1', 'claude-code', 'try again at 10pm');
      expect(handler).toHaveBeenCalledTimes(2);
      // Only one pending schedule after both calls
      expect(pm.getPendingSchedule('s1')).not.toBeNull();
    });
  });

  describe('wait-until with waitMs fallback', () => {
    it('uses waitMs when timeGroup missing', () => {
      const rule = makeWaitRule({ timeGroup: undefined, waitMs: 3_600_000 });
      const { pm, ptyWrite } = makeMatcher([rule]);
      pm.processOutput('s1', 'claude-code', 'try again at 9pm');
      vi.advanceTimersByTime(3_600_001);
      expect(ptyWrite).toHaveBeenCalledWith('s1', '/resume\r');
    });

    it('skips rule when neither timeGroup match nor waitMs', () => {
      const rule = makeWaitRule({
        regex: 'Usage limit',
        timeGroup: undefined,
        waitMs: undefined,
      });
      const { pm, ptyWrite } = makeMatcher([rule]);
      pm.processOutput('s1', 'claude-code', 'Usage limit reached');
      expect(ptyWrite).not.toHaveBeenCalled();
    });
  });

  describe('cancelSchedule', () => {
    it('cancels a pending schedule', () => {
      const { pm, ptyWrite } = makeMatcher([makeWaitRule()]);
      pm.processOutput('s1', 'claude-code', 'try again at 9pm');
      pm.cancelSchedule('s1');
      vi.runAllTimers();
      expect(ptyWrite).not.toHaveBeenCalled();
    });

    it('emits schedule-cancelled on cancel', () => {
      const { pm } = makeMatcher([makeWaitRule()]);
      const handler = vi.fn();
      pm.on('schedule-cancelled', handler);
      pm.processOutput('s1', 'claude-code', 'try again at 9pm');
      pm.cancelSchedule('s1');
      expect(handler).toHaveBeenCalledWith({ sessionId: 's1' });
    });

    it('does nothing when no schedule pending', () => {
      const { pm } = makeMatcher([]);
      expect(() => pm.cancelSchedule('s1')).not.toThrow();
    });

    it('getPendingSchedule returns null after cancel', () => {
      const { pm } = makeMatcher([makeWaitRule()]);
      pm.processOutput('s1', 'claude-code', 'try again at 9pm');
      pm.cancelSchedule('s1');
      expect(pm.getPendingSchedule('s1')).toBeNull();
    });
  });

  describe('removeSession', () => {
    it('cancels pending schedule and clears lastFired', () => {
      const { pm, ptyWrite } = makeMatcher([makeWaitRule()]);
      pm.processOutput('s1', 'claude-code', 'try again at 9pm');
      pm.removeSession('s1');
      vi.runAllTimers();
      expect(ptyWrite).not.toHaveBeenCalled();
      expect(pm.getPendingSchedule('s1')).toBeNull();
    });

    it('allows the rule to fire again after removeSession', () => {
      const { pm, ptyWrite } = makeMatcher([makeRule({ cooldownMs: 5_000 })]);
      pm.processOutput('s1', 'claude-code', 'rate limit');
      pm.removeSession('s1');
      pm.processOutput('s1', 'claude-code', 'rate limit');
      expect(ptyWrite).toHaveBeenCalledTimes(2);
    });
  });

  describe('dispose', () => {
    it('cancels all pending schedules', () => {
      const { pm, ptyWrite } = makeMatcher([makeWaitRule()]);
      pm.processOutput('s1', 'claude-code', 'try again at 9pm');
      pm.processOutput('s2', 'claude-code', 'try again at 9pm');
      pm.dispose();
      vi.runAllTimers();
      expect(ptyWrite).not.toHaveBeenCalled();
    });
  });

  describe('multiple rules', () => {
    it('processes all rules in order', () => {
      const rules = [
        makeRule({ regex: 'rule one', sequence: 'one{Enter}' }),
        makeRule({ regex: 'rule two', sequence: 'two{Enter}' }),
      ];
      const { pm, ptyWrite } = makeMatcher(rules);
      pm.processOutput('s1', 'claude-code', 'rule one and rule two hit');
      expect(ptyWrite).toHaveBeenCalledWith('s1', 'one\r');
      expect(ptyWrite).toHaveBeenCalledWith('s1', 'two\r');
    });

    it('getPatterns called with correct cliType', () => {
      const { pm, getPatterns } = makeMatcher([]);
      pm.processOutput('s1', 'copilot-cli', 'test');
      expect(getPatterns).toHaveBeenCalledWith('copilot-cli');
    });
  });

  describe('default rate-limit patterns', () => {
    describe('claude-code patterns', () => {
      const claudeCodePatterns: PatternRule[] = [
        {
          regex: 'rate limit',
          action: 'send-text',
          sequence: '{Ctrl+c}retry{Enter}',
          cooldownMs: 60000,
        },
        {
          regex: 'too many requests',
          action: 'send-text',
          sequence: '{Ctrl+c}retry{Enter}',
          cooldownMs: 60000,
        },
        {
          regex: 'try again at (\\d{1,2}(?::\\d{2})?(?:am|pm))',
          action: 'wait-until',
          timeGroup: 1,
          onResume: 'resume{Enter}',
          cooldownMs: 300000,
        },
        {
          regex: 'usage limit|quota exceeded|limit reached',
          action: 'wait-until',
          waitMs: 3600000,
          onResume: '{Ctrl+c}retry{Enter}',
          cooldownMs: 300000,
        },
      ];

      it('rate limit pattern sends immediate cancel+retry', () => {
        const { pm, ptyWrite } = makeMatcher(claudeCodePatterns);
        pm.processOutput('s1', 'claude-code', 'Error: rate limit exceeded');
        expect(ptyWrite).toHaveBeenCalledWith('s1', '\x03retry\r');
      });

      it('too many requests pattern sends immediate cancel+retry', () => {
        const { pm, ptyWrite } = makeMatcher(claudeCodePatterns);
        pm.processOutput('s1', 'claude-code', 'Error: too many requests, please slow down');
        expect(ptyWrite).toHaveBeenCalledWith('s1', '\x03retry\r');
      });

      it('scheduled retry parses time from capture group', () => {
        const { pm, ptyWrite } = makeMatcher(claudeCodePatterns);
        const handler = vi.fn();
        pm.on('schedule-created', handler);
        pm.processOutput('s1', 'claude-code', 'Please try again at 9:30pm');
        expect(handler).toHaveBeenCalled();
        vi.runAllTimers();
        expect(ptyWrite).toHaveBeenCalledWith('s1', 'resume\r');
      });

      it('usage limit pattern waits 1 hour then cancels and retries', () => {
        const { pm, ptyWrite } = makeMatcher(claudeCodePatterns);
        pm.processOutput('s1', 'claude-code', 'Usage limit reached for this hour');
        vi.advanceTimersByTime(3600001);
        expect(ptyWrite).toHaveBeenCalledWith('s1', '\x03retry\r');
      });

      it('quota exceeded pattern waits 1 hour then cancels and retries', () => {
        const { pm, ptyWrite } = makeMatcher(claudeCodePatterns);
        pm.processOutput('s1', 'claude-code', 'Quota exceeded, please try again later');
        vi.advanceTimersByTime(3600001);
        expect(ptyWrite).toHaveBeenCalledWith('s1', '\x03retry\r');
      });
    });

    describe('copilot-cli patterns', () => {
      const copilotPatterns: PatternRule[] = [
        {
          regex: 'rate limit|rate-limit exceeded',
          action: 'send-text',
          sequence: '{Ctrl+c}retry{Enter}',
          cooldownMs: 60000,
        },
        {
          regex: 'try again (?:in \\d+ minutes?|at (\\d{1,2}(?::\\d{2})?(?:am|pm)))',
          action: 'wait-until',
          timeGroup: 1,
          onResume: 'retry{Enter}',
          cooldownMs: 300000,
        },
      ];

      it('rate limit pattern sends immediate cancel+retry', () => {
        const { pm, ptyWrite } = makeMatcher(copilotPatterns);
        pm.processOutput('s1', 'copilot-cli', 'Error: rate limit exceeded');
        expect(ptyWrite).toHaveBeenCalledWith('s1', '\x03retry\r');
      });

      it('rate-limit pattern also matches', () => {
        const { pm, ptyWrite } = makeMatcher(copilotPatterns);
        pm.processOutput('s1', 'copilot-cli', 'rate-limit exceeded, try again later');
        expect(ptyWrite).toHaveBeenCalledWith('s1', '\x03retry\r');
      });

      it('scheduled retry parses time from "try again at 9pm"', () => {
        const { pm, ptyWrite } = makeMatcher(copilotPatterns);
        pm.processOutput('s1', 'copilot-cli', 'Please try again at 9pm');
        vi.runAllTimers();
        expect(ptyWrite).toHaveBeenCalledWith('s1', 'retry\r');
      });

      it('"try again in 5 minutes" matches but has no timeGroup, so uses fallback', () => {
        // This pattern matches "try again in X minutes" but has no timeGroup
        // Since there's no waitMs either, the rule logs a warning and skips
        const { pm, ptyWrite } = makeMatcher(copilotPatterns);
        pm.processOutput('s1', 'copilot-cli', 'Please try again in 5 minutes');
        // No immediate action - schedule creation requires valid time or waitMs
        // The rule will log a warning and skip
        expect(ptyWrite).not.toHaveBeenCalled();
      });
    });
  });
});
