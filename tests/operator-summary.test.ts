/**
 * operatorSummary / withoutOperator — the sidebar's pinned Helm section.
 */
import { describe, it, expect } from 'vitest';
import { operatorSummary, withoutOperator } from '../renderer/operator-summary';
import { buildFlatNavList, buildSessionGroups, findNavIndexBySessionId } from '../renderer/session-groups';

const worker = { id: 'w1', name: 'worker', cliType: 'claude-code', workingDir: 'X:/a' } as any;
const operator = { id: 'op', name: 'Helm', cliType: 'claude-code', workingDir: 'X:/a', role: 'operator' } as any;

describe('operatorSummary', () => {
  it('is off when no session has the operator role', () => {
    expect(operatorSummary([worker], new Map(), [])).toEqual({ kind: 'off' });
  });

  it('reports the operator, its activity and the newest Helm line', () => {
    const summary = operatorSummary([worker, operator], new Map([['op', 'active']]), [
      { from: 'helm', text: 'old' }, { from: 'helm', text: 'newest' }, { from: 'you', text: 'hi' },
    ]);
    expect(summary).toEqual({ kind: 'on', id: 'op', activityLevel: 'active', lastReply: 'newest' });
  });

  it('defaults to idle with no reply yet', () => {
    expect(operatorSummary([operator], new Map(), [])).toEqual({ kind: 'on', id: 'op', activityLevel: 'idle', lastReply: null });
  });
});

describe('withoutOperator', () => {
  it('keeps the operator out of the regular session groups', () => {
    expect(withoutOperator([worker, operator])).toEqual([worker]);
    const groups = buildSessionGroups([worker, operator], () => 'X:/a', { order: [], collapsed: [] }, []);
    expect(groups.flatMap(g => g.sessions).map(s => s.id)).toEqual(['w1']);
  });
});

describe('operator as a gamepad nav target', () => {
  it('is the pinned first nav item and found by session id', () => {
    const groups = buildSessionGroups([worker, operator], () => 'X:/a', { order: [], collapsed: [] }, []);
    const nav = buildFlatNavList(groups, 'op');
    expect(nav[0]).toEqual({ type: 'operator', id: 'op', groupIndex: -1 });
    expect(nav.map(item => item.type)).toEqual(['operator', 'group-header', 'session-card']);
    expect(findNavIndexBySessionId(nav, 'op')).toBe(0);
  });

  it('is absent when the operator is off', () => {
    const groups = buildSessionGroups([worker], () => 'X:/a', { order: [], collapsed: [] }, []);
    expect(buildFlatNavList(groups, null).some(item => item.type === 'operator')).toBe(false);
  });
});
