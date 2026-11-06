import { describe, expect, it, vi } from 'vitest';
import { callMcpTool } from '../src/mcp/tools/dispatcher.js';

function makeDeps() {
  const todos: string[] = [];
  const service = {
    getSkill: vi.fn((id: string) => (id === 'missing' ? null : { id, name: `skill ${id}` })),
    getPlan: vi.fn((id: string) => ({ id, title: `plan ${id}` })),
    addSessionTodo: vi.fn((_s: string, text: string) => { todos.push(text); return { id: `t${todos.length}`, text }; }),
    completeSessionTodo: vi.fn((_s: string, id: string) => ({ id, done: true })),
    setSessionMission: vi.fn((_s: string, text: string) => ({ text })),
    setSessionEta: vi.fn((_s: string, eta: { minutes: unknown }) => ({ minutes: eta.minutes })),
  };
  return {
    deps: { service: service as any, setPlanStateWithValidation: vi.fn(), completePlanWithValidation: vi.fn() } as any,
    service,
    todos,
  };
}

const AUTH = { sessionId: 'sess-1' };

describe('MCP batch arguments', () => {
  it('skill_get ids[] returns every skill in one call and reports misses per id', async () => {
    const { deps } = makeDeps();
    const result = await callMcpTool(deps, 'skill_get', { ids: ['a', 'missing', 'b'] }, AUTH);
    expect(result).toEqual({
      items: [{ id: 'a', name: 'skill a' }, { id: 'b', name: 'skill b' }],
      errors: [{ id: 'missing', error: 'Skill not found: missing' }],
    });
  });

  it('plan_get ids[] fetches several plans', async () => {
    const { deps } = makeDeps();
    const result: any = await callMcpTool(deps, 'plan_get', { ids: ['p1', 'p2'] }, AUTH);
    expect(result.items.map((p: { id: string }) => p.id)).toEqual(['p1', 'p2']);
  });

  it('session_todo_add items[] adds in order; session_todo_done ids[] completes each', async () => {
    const { deps, todos, service } = makeDeps();
    await callMcpTool(deps, 'session_todo_add', { items: ['one', 'two', 'three'] }, AUTH);
    await callMcpTool(deps, 'session_todo_done', { ids: ['t1', 't3'] }, AUTH);
    expect(todos).toEqual(['one', 'two', 'three']);
    expect(service.completeSessionTodo.mock.calls.map((c) => c[1])).toEqual(['t1', 't3']);
  });

  it('rejects passing both the single and the batch argument', async () => {
    const { deps } = makeDeps();
    await expect(callMcpTool(deps, 'skill_get', { id: 'a', ids: ['b'] }, AUTH)).rejects.toThrow(/either id or ids/);
  });

  it('session_mission_set with etaMinutes sets mission and ETA in one call', async () => {
    const { deps, service } = makeDeps();
    const result = await callMcpTool(deps, 'session_mission_set', { text: 'Ship it', etaMinutes: 20 }, AUTH);
    expect(service.setSessionEta).toHaveBeenCalledWith('sess-1', expect.objectContaining({ minutes: 20 }));
    expect(result).toEqual({ mission: { text: 'Ship it' }, eta: { minutes: 20 } });
  });
});

describe('session_read_terminal default mode', () => {
  it('defaults to stripped so the model is not sent raw ANSI and a stripped copy', async () => {
    const readSessionTerminal = vi.fn(() => ({ lines: [] }));
    const deps = { service: { readSessionTerminal }, setPlanStateWithValidation: vi.fn(), completePlanWithValidation: vi.fn() } as any;
    await callMcpTool(deps, 'session_read_terminal', { sessionId: 's1', lines: 20 }, AUTH);
    expect(readSessionTerminal).toHaveBeenCalledWith('s1', 20, 'stripped', undefined);
  });
});
