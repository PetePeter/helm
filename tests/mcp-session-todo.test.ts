import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../src/types/session.js';
import type { SessionTodo } from '../src/types/todo.js';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/session/persistence.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/session/persistence.js')>()),
  saveSessions: () => {},
  loadSessions: () => [],
}));

const { SessionManager } = await import('../src/session/manager.js');
const { TodoManager } = await import('../src/session/todo-manager.js');
const { HelmControlService } = await import('../src/mcp/helm-control-service.js');
const { callMcpTool } = await import('../src/mcp/tools/dispatcher.js');
const { MCP_TOOLS } = await import('../src/mcp/tools/definitions.js');
const { getAvailableTools } = await import('../src/mcp/guides/available-tools.js');

function session(id: string, name: string): SessionInfo {
  return { id, name, cliType: 'claude-code', processId: 1 };
}

function memoryStore() {
  const files = new Map<string, SessionTodo[]>();
  return {
    load: (id: string) => files.get(id) ?? null,
    save: (id: string, todos: SessionTodo[]) => { files.set(id, todos); },
    remove: (id: string) => { files.delete(id); },
    list: () => [...files.keys()],
  };
}

const TOOLS = ['session_todo_add', 'session_todo_done', 'session_todo_delete', 'session_todo_clear', 'session_todo_list'];

describe('MCP session_todo_*', () => {
  let todos: InstanceType<typeof TodoManager>;
  let call: (tool: string, args?: Record<string, unknown>, auth?: { sessionId?: string }) => Promise<any>;

  beforeEach(() => {
    const sessions = new SessionManager();
    sessions.addSession(session('me', 'caller'));
    sessions.addSession(session('other', 'sibling'));
    todos = new TodoManager(memoryStore(), () => 'generated-id', () => 5000);
    const configLoader = { getCliTypeLabel: (ref: string) => ref, getCliTypeEntry: () => null, getCliTypes: () => [] };
    const service = new HelmControlService({} as never, sessions, {} as never, configLoader as never);
    service.setTodoManager(todos);
    const deps = { service, setPlanStateWithValidation: vi.fn(), completePlanWithValidation: vi.fn() };
    call = (tool, args = {}, auth = { sessionId: 'me' }) => callMcpTool(deps, tool, args, auth) as Promise<any>;
  });

  it('publishes the five tools with the requested arguments', () => {
    const byName = new Map(MCP_TOOLS.map(tool => [tool.name, tool]));
    expect(getAvailableTools().map(tool => tool.name)).toEqual(expect.arrayContaining(TOOLS));
    expect(byName.get('session_todo_add')?.inputSchema.required).toEqual(['text']);
    expect(byName.get('session_todo_done')?.inputSchema.required).toEqual(['id']);
    expect(byName.get('session_todo_delete')?.inputSchema.required).toEqual(['id']);
    expect(byName.get('session_todo_clear')?.inputSchema.required).toBeUndefined();
    expect(byName.get('session_todo_list')?.inputSchema.required).toBeUndefined();
    for (const name of TOOLS) expect(byName.get(name)?.inputSchema.additionalProperties).toBe(false);
  });

  it('adds, lists, completes, deletes completed items, and clears only the caller\'s list', async () => {
    const added = await call('session_todo_add', { text: 'Ship the UI' });
    expect(added).toMatchObject({ id: 'generated-id', text: 'Ship the UI', status: 'open' });
    expect(await call('session_todo_list')).toEqual([added]);
    expect(await call('session_todo_done', { id: added.id })).toMatchObject({ id: added.id, status: 'done' });
    expect(await call('session_todo_delete', { id: added.id })).toBe(true);

    todos.add('other', 'Keep this');
    expect(await call('session_todo_clear')).toBe(0);
    expect(todos.list('other').map(todo => todo.text)).toEqual(['Keep this']);
  });

  it('refuses deleting open todos and never lets a caller address another session', async () => {
    const other = todos.add('other', 'Private to sibling');
    const own = await call('session_todo_add', { text: 'Own item' });
    await expect(call('session_todo_delete', { id: own.id })).rejects.toThrow(/open todo/i);
    await expect(call('session_todo_done', { id: other.id, sessionId: 'other' })).rejects.toThrow(/own session/);
    expect(await call('session_todo_list')).toEqual([own]);
    expect(todos.list('other')).toEqual([other]);
  });

  it('requires authenticated callers and validates IDs and text', async () => {
    for (const tool of TOOLS) {
      await expect(call(tool, { text: 'item', id: 'id' }, {})).rejects.toThrow(/could not determine your session/);
    }
    await expect(call('session_todo_add', { text: '  ' })).rejects.toThrow(/text is required/);
    await expect(call('session_todo_done', { id: '' })).rejects.toThrow(/id is required/);
    await expect(call('session_todo_list', {}, { sessionId: 'mobile:phone' })).rejects.toThrow(/Session not found/);
  });
});
