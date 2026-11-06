import { describe, it, expect } from 'vitest';
import { getToolReminder } from '../src/mcp/tools/reminders';

describe('getToolReminder', () => {
  it('should return empty string for unknown tool', () => {
    expect(getToolReminder('nonexistent_tool')).toBe('');
  });

  it('should return reminder for session_send_text', () => {
    const reminder = getToolReminder('session_send_text');
    expect(reminder.length).toBeGreaterThan(0);
  });
});
