import { describe, it, expect } from 'vitest';
import { buildStartupGuide } from '../src/mcp/guides/startup-guide';
import { getAvailableTools } from '../src/mcp/guides/available-tools';

describe('buildStartupGuide', () => {
  it('returns a non-empty string', () => {
    expect(typeof buildStartupGuide()).toBe('string');
    expect(buildStartupGuide().length).toBeGreaterThan(0);
  });

  it('returns exactly 8 newline-separated rules', () => {
    const lines = buildStartupGuide().trim().split('\n').filter(l => l.trim().length > 0);
    expect(lines).toHaveLength(8);
  });

  it('contains no JSON structural syntax', () => {
    const body = buildStartupGuide();
    expect(body).not.toMatch(/^\s*\{/);
    expect(body).not.toMatch(/"[a-z_]+"\s*:/);
  });

  it('contains session_plan_claim', () => {
    expect(buildStartupGuide()).toContain('session_plan_claim');
  });

  it('contains plan_get', () => {
    expect(buildStartupGuide()).toContain('plan_get');
  });

  it('keeps seed guidance on the kind=idea rule', () => {
    const ideaRule = buildStartupGuide().split('\n').find((line) => line.includes('kind=idea'));
    expect(ideaRule).toContain('stage seed');
  });

  it('contains notify_user', () => {
    expect(buildStartupGuide()).toContain('notify_user');
  });

  it('contains skill_submit_feedback', () => {
    expect(buildStartupGuide()).toContain('skill_submit_feedback');
  });

  it('lists the skill review read/clear tools', () => {
    const tools = getAvailableTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('skill_get_feedback');
    expect(names).toContain('skill_clear_reviews');
  });

});
