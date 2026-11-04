/**
 * The TypeScript plan-status palette must stay aligned with the CSS tokens used
 * by the canvas and sidebar indicators.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PLAN_STATUS_COLORS, getPlanStatusColor } from '../../renderer/state-colors.js';

const CSS = readFileSync(join(__dirname, '../../renderer/styles/main.css'), 'utf8');

describe('plan status colors', () => {
  it('matches every --status-* token in main.css', () => {
    expect(Object.keys(PLAN_STATUS_COLORS).sort()).toEqual([
      'blocked', 'coding', 'done', 'planning', 'ready', 'review', 'suggested',
    ]);
    for (const [status, color] of Object.entries(PLAN_STATUS_COLORS)) {
      const token = `--status-${status}`;
      expect(CSS).toMatch(new RegExp(`${token}\\s*:\\s*${color};`));
    }
  });

  it('defaults unknown statuses to planning', () => {
    expect(getPlanStatusColor('unknown')).toBe(PLAN_STATUS_COLORS.planning);
  });
});
