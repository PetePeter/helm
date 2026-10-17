/** The shared timesheet chart: one markup for the desktop pane and the phone WebView. */
import { describe, expect, it } from 'vitest';
import { renderTimesheetChart, renderTokenChart } from '../src/session/timesheet-chart.js';
import type { Timesheet } from '../src/session/time-tracker.js';

const DAY0 = new Date(2026, 8, 28).getTime();
const sheet = (user: number[], ai: number[], tokens: number[]): Timesheet => ({
  columns: user.map((_, i) => DAY0 + i * 86_400_000), rows: [], totals: { user, ai, tokens },
});
const numbers = (html: string) => [...html.matchAll(/(?:height|y|cy)="([^"]*)"/g)].map(m => m[1]);

describe('renderTimesheetChart', () => {
  it('draws a bar per non-zero time value and a token point per column', () => {
    const html = renderTimesheetChart(sheet([60, 0], [120, 30], [1_000, 0]), 'day');
    expect(html.match(/class="s-you"[\s\S]*?<\/g>/)![0].match(/<rect/g)).toHaveLength(1);
    expect(html.match(/class="s-ai"[\s\S]*?<\/g>/)![0].match(/<rect/g)).toHaveLength(2);
    expect(html.match(/<circle/g)).toHaveLength(2);
  });

  it('fits the tallest bar and token point inside the plot under round top labels', () => {
    const html = renderTimesheetChart(sheet([60], [230], [4_200]), 'day');
    const aiY = Number(html.match(/class="s-ai"[\s\S]*?<rect[^>]*y="([\d.]+)"/)![1]);
    const tokY = Number(html.match(/<circle[^>]*cy="([\d.]+)"/)![1]);
    for (const y of [aiY, tokY]) { expect(y).toBeGreaterThanOrEqual(20); expect(y).toBeLessThan(80); }
    expect(html).toContain('>4h</text>');
    expect(html).toContain('>5k</text>');
  });

  it('ends the plot at the current column, never drawing the future', () => {
    const now = DAY0 + 86_400_000 + 3_600_000; // during the second column
    const html = renderTimesheetChart(sheet([0, 0, 0], [0, 0, 0], [100, 0, 0]), 'day', now);
    expect(html.match(/<circle/g)).toHaveLength(2);
    expect(html.match(/points="([^"]*)"/)![1].split(' ')).toHaveLength(2);
    expect(html).toContain('>Tue 29<');
    expect(html).not.toContain('>Wed 30<');
  });

  it('scales a day of parallel AI time past 24h to a tight top, not whole days', () => {
    const html = renderTimesheetChart(sheet([60], [29 * 60], [0]), 'day');
    expect(html).toContain('>32h</text>');
  });

  it('renders an empty period without NaN', () => {
    const html = renderTimesheetChart(sheet([0, 0], [0, 0], [0, 0]), 'hour');
    expect(numbers(html).some(v => v.includes('NaN') || v.includes('Infinity'))).toBe(false);
    expect(html).not.toMatch(/NaN|Infinity/);
  });

  it('offers You / AI / Tokens toggles that hide their series and the token axis', () => {
    const html = renderTimesheetChart(sheet([5], [5], [5]), 'day');
    for (const s of ['you', 'ai', 'tok']) {
      expect(html).toMatch(new RegExp(`type="checkbox"[^>]*id="tsc-${s}"[^>]*checked`));
      expect(html).toContain(`#tsc-${s}:not(:checked)~svg .s-${s}{display:none}`);
    }
    expect(html).toMatch(/<g[^>]*class="s-tok"[^>]*text-anchor="start"|<g[^>]*text-anchor="start"[^>]*class="s-tok"/);
  });
});

describe('renderTokenChart', () => {
  it('stacks one segment per CLI with tokens and omits zero-total legend rows', () => {
    const columns = [DAY0, DAY0 + 86_400_000];
    const html = renderTokenChart({ columns, rows: [
      { cliType: 'claude-code', label: 'claude-code', tokens: [1_000, 0] },
      { cliType: 'codex', label: 'codex', tokens: [500, 500] },
      { cliType: 'copilot', label: 'copilot', tokens: [0, 0] },
    ], totals: [1_500, 500] }, 'day', DAY0 + 2 * 86_400_000);
    expect(html.match(/<rect/g)).toHaveLength(3);
    expect(html).toContain('claude-code 1k');
    expect(html).not.toContain('copilot');
  });

  it('keeps a large weekly CLI visible without zero-total legend chips', () => {
    const columns = Array.from({ length: 7 }, (_, i) => DAY0 + i * 86_400_000);
    const luna = [1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_090_000, 0, 0];
    const rows = [
      { cliType: 'luna-xhigh', label: 'luna-xhigh', tokens: luna },
      ...Array.from({ length: 12 }, (_, i) => ({ cliType: `unused-${i}`, label: `unused-${i}`, tokens: Array(7).fill(0) })),
    ];
    const html = renderTokenChart({ columns, rows, totals: [...luna] }, 'day', DAY0 + 7 * 86_400_000);
    const bar = html.match(/<rect[^>]*>/)?.[0];

    expect(html).toContain('luna-xhigh 5.09M');
    expect(html).not.toContain('unused-');
    expect(bar).toBeDefined();
    expect(Number(bar!.match(/y="([\d.]+)"/)![1])).toBeLessThan(260);
    expect(Number(bar!.match(/height="([\d.]+)"/)![1])).toBeGreaterThan(100);
  });

  it('escapes CLI names in the legend', () => {
    const html = renderTokenChart({ columns: [DAY0], rows: [{ cliType: '<b>x', label: '<b>x', tokens: [1] }], totals: [1] }, 'day', DAY0 + 1);
    expect(html).not.toContain('<b>x');
  });
});
