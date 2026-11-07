import { describe, it, expect } from 'vitest';
import { buildNotificationGuide } from '../src/mcp/guides/notification-guide';

describe('buildNotificationGuide', () => {
  const guide = buildNotificationGuide();

  it('returns a string, not a JSON object', () => {
    expect(typeof guide).toBe('string');
    expect(guide.startsWith('{')).toBe(false);
  });

  it('references notify_user as preferred tool', () => {
    expect(guide).toContain('notify_user');
  });

  it('covers completion, blocked, and error trigger conditions', () => {
    expect(guide).toContain('completes');
    expect(guide).toContain('blocked');
    expect(guide).toContain('error');
  });

  it('includes Work complete and Need your input example titles', () => {
    expect(guide).toContain('Work complete');
    expect(guide).toContain('Need your input');
  });

  it('documents all routing outcomes', () => {
    for (const key of ['toast', 'taskbar_flash', 'bubble', 'phone', 'none']) {
      expect(guide).toContain(key);
    }
  });
});
