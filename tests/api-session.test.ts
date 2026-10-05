import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { runAgentTurn, parseToolArguments, cleanModelText } = await import('../src/session/api/api-agent-loop.js');
const { chunkForChat, selectApiTools, listAvailableApiTools, buildSystemPrompt, formatSenderTag, parseSenderTag, formatChatHistory } = await import('../src/session/api/api-prompt.js');
const { ApiSessionProcess, dropTurns, forgetNudge, rescaleTokens, trimForOverflow, isContextOverflow } = await import('../src/session/api/api-session-process.js');
const { ApiSessionHost } = await import('../src/session/api/api-session-host.js');
const { NATIVE_TOOLS, globToRegExp } = await import('../src/session/api/api-native-tools.js');

type Msg = import('../src/session/api/api-agent-loop.js').ChatMessage;
type Result = import('../src/session/api/api-agent-loop.js').CompletionResult;

/** A scripted model: each complete() returns the next reply and records what it was sent. */
function scriptedClient(replies: Result['message'][]) {
  const calls: Array<{ messages: Msg[]; toolNames: string[] }> = [];
  return {
    calls,
    complete: async (messages: Msg[], tools: Array<{ name: string }>) => {
      calls.push({ messages: structuredClone(messages), toolNames: tools.map((t) => t.name) });
      const next = replies.shift();
      if (!next) throw new Error('script exhausted');
      return { message: next };
    },
  };
}

const last = <T,>(items: T[]): T => items[items.length - 1];
const toolCall = (id: string, name: string, args: string) => ({ id, type: 'function' as const, function: { name, arguments: args } });

describe('runAgentTurn', () => {
  it('runs tool calls and feeds results back until the model answers in text', async () => {
    const client = scriptedClient([
      { content: '', tool_calls: [toolCall('c1', 'Read', '{"file_path":"a.txt"}')] },
      { content: 'The file says hi.' },
    ]);
    const executed: string[] = [];
    const result = await runAgentTurn({
      client,
      system: 'SYS',
      tools: [{ name: 'Read', description: '', parameters: {} }],
      history: [],
      userContent: 'read a.txt',
      executeTool: async (name, args) => { executed.push(`${name}:${args.file_path}`); return 'hi'; },
    });
    expect(executed).toEqual(['Read:a.txt']);
    expect(result.finalText).toBe('The file says hi.');
    expect(result.toolsUsed).toEqual(['Read']);
    // Second request carries the tool result, keyed to the call id.
    expect(last(client.calls[1].messages)).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'hi' });
    expect(client.calls[1].messages[0]).toEqual({ role: 'system', content: 'SYS' });
  });

  it('counts completion rounds that return reasoning metadata, not visible thought text', async () => {
    const client = scriptedClient([
      { reasoning_content: 'thinking', content: '', tool_calls: [toolCall('c1', 'Read', '{}')] },
      { reasoning_content: 'still thinking', content: 'answer' },
    ]);
    const result = await runAgentTurn({
      client, system: '', tools: [{ name: 'Read', description: '', parameters: {} }], history: [], userContent: 'x',
      executeTool: async () => 'ok',
    });
    expect(result.thoughtCount).toBe(2);
  });

  it('keeps the prompt prefix stable: prior history is sent unchanged and never mutated', async () => {
    const history: Msg[] = [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'ok' }];
    const client = scriptedClient([{ content: 'done' }]);
    const result = await runAgentTurn({
      client, system: 'SYS', tools: [], history, userContent: 'next', executeTool: async () => '',
    });
    expect(history).toHaveLength(2);
    expect(client.calls[0].messages.slice(1, 3)).toEqual(history);
    expect(result.history).toHaveLength(4);
  });

  it('returns malformed tool arguments to the model as an error instead of throwing', async () => {
    const client = scriptedClient([
      { content: '', tool_calls: [toolCall('c1', 'Read', '{not json')] },
      { content: 'sorry' },
    ]);
    const executeTool = vi.fn();
    await runAgentTurn({ client, system: '', tools: [{ name: 'Read', description: '', parameters: {} }], history: [], userContent: 'x', executeTool });
    expect(executeTool).not.toHaveBeenCalled();
    expect(last(client.calls[1].messages).content).toMatch(/not valid JSON/);
  });

  it('turns a throwing tool into an error result the model can read', async () => {
    const client = scriptedClient([
      { content: '', tool_calls: [toolCall('c1', 'Shell', '{}')] },
      { content: 'handled' },
    ]);
    const result = await runAgentTurn({
      client, system: '', tools: [{ name: 'Shell', description: '', parameters: {} }], history: [], userContent: 'x',
      executeTool: async () => { throw new Error('boom'); },
    });
    expect(last(client.calls[1].messages).content).toBe('Error: boom');
    expect(result.finalText).toBe('handled');
  });

  it('withholds tools on the final allowed round so a looping model must answer', async () => {
    const loop = { content: '', tool_calls: [toolCall('c', 'Read', '{}')] };
    const client = scriptedClient([loop, loop, { content: 'gave up', tool_calls: [toolCall('c', 'Read', '{}')] }]);
    const result = await runAgentTurn({
      client, system: '', tools: [{ name: 'Read', description: '', parameters: {} }], history: [], userContent: 'x',
      executeTool: async () => 'r', maxToolRounds: 2,
    });
    expect(client.calls.map((c) => c.toolNames.length)).toEqual([1, 1, 0]);
    expect(result.finalText).toBe('gave up');
  });

  it('rollback forgets everything since a checkpoint and keeps only the note', async () => {
    const client = scriptedClient([
      { content: '', tool_calls: [toolCall('k', 'checkpoint', '{"label":"journey"}')] },
      { content: '', tool_calls: [toolCall('r1', 'Read', '{"file_path":"big.txt"}')] },
      { content: '', tool_calls: [toolCall('rb', 'rollback', '{"label":"journey","note":"answer is 42, saved as memory m9"}')] },
      { content: 'The answer is 42.' },
    ]);
    const checkpoints = new Map<string, number>();
    const result = await runAgentTurn({
      client, system: 'SYS', tools: [{ name: 'Read', description: '', parameters: {} }],
      history: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'ok' }],
      userContent: 'find the answer',
      executeTool: async () => 'x'.repeat(5000),
      checkpoints,
    });
    // The request after the rollback: prior history + question + the note — the journey is gone.
    expect(client.calls[3].messages.map((m) => m.content)).toEqual([
      'SYS', 'earlier', 'ok', 'find the answer', '[Rolled back to checkpoint "journey". Your note: answer is 42, saved as memory m9]',
    ]);
    expect(result.finalText).toBe('The answer is 42.');
    expect(result.history.some((m) => m.content?.startsWith('xxx'))).toBe(false);
  });

  it('checkpoints automatically before an Agent batch, so the batch can be rolled back', async () => {
    const client = scriptedClient([
      { content: '', tool_calls: [toolCall('a1', 'Agent', '{"tasks":[]}')] },
      { content: '', tool_calls: [toolCall('rb', 'rollback', '{"label":"agents-1","note":"see memory m2"}')] },
      { content: 'done' },
    ]);
    const checkpoints = new Map<string, number>();
    await runAgentTurn({
      client, system: 'SYS', tools: [{ name: 'Agent', description: '', parameters: {} }], history: [],
      userContent: 'research', executeTool: async () => 'result memory m2', checkpoints,
    });
    expect(last(client.calls[1].messages).content).toMatch(/^result memory m2\n\n\[Checkpoint "agents-1" was set/);
    expect(client.calls[2].messages.map((m) => m.content)).toEqual([
      'SYS', 'research', '[Rolled back to checkpoint "agents-1". Your note: see memory m2]',
    ]);
  });

  it('deferred tools: offered only after load_tools, which returns their descriptions; loads survive in history', async () => {
    const memory = { name: 'memory_search', description: 'Search memories', parameters: { type: 'object' } };
    const client = scriptedClient([
      { content: '', tool_calls: [toolCall('l', 'load_tools', '{"names":["memory_search","nope"]}')] },
      { content: 'loaded' },
    ]);
    const result = await runAgentTurn({
      client, system: '', tools: [{ name: 'Read', description: '', parameters: {} }], deferredTools: [memory],
      history: [], userContent: 'x', executeTool: async () => '',
    });
    expect(client.calls[0].toolNames).toEqual(['Read', 'load_tools']);
    expect(last(client.calls[1].messages).content).toBe('memory_search — loaded. Search memories\nnope — not available');
    expect(client.calls[1].toolNames).toEqual(['Read', 'load_tools', 'memory_search']);
    // A later turn over the same history still offers it — nothing to re-load.
    const next = scriptedClient([{ content: 'ok' }]);
    await runAgentTurn({
      client: next, system: '', tools: [], deferredTools: [memory], history: result.history, userContent: 'y', executeTool: async () => '',
    });
    expect(next.calls[0].toolNames).toEqual(['load_tools', 'memory_search']);
  });

  it('a deferred tool called by name without load_tools just runs, and is offered from then on', async () => {
    const memory = { name: 'memory_search', description: 'Search memories', parameters: { type: 'object' } };
    const ran: string[] = [];
    const client = scriptedClient([
      { content: '', tool_calls: [toolCall('m', 'memory_search', '{"query":"x"}')] },
      { content: 'found' },
    ]);
    await runAgentTurn({
      client, system: '', tools: [], deferredTools: [memory], history: [], userContent: 'x',
      executeTool: async (name) => { ran.push(name); return 'hit'; },
    });
    expect(ran).toEqual(['memory_search']);
    expect(client.calls[1].toolNames).toContain('memory_search');
  });

  it('request_tool for a tool the model already has hands it over instead of asking the user', async () => {
    const send = { name: 'session_send_text', description: 'Send text', parameters: { type: 'object' } };
    const ran: string[] = [];
    const client = scriptedClient([
      { content: '', tool_calls: [toolCall('r', 'request_tool', '{"name":"session_send_text","purpose":"message a session"}')] },
      { content: 'ok' },
    ]);
    await runAgentTurn({
      client, system: '', tools: [], deferredTools: [send], history: [], userContent: 'x',
      executeTool: async (name) => { ran.push(name); return ''; },
    });
    expect(ran).toEqual([]); // never filed with the user
    expect(last(client.calls[1].messages).content).toMatch(/^You already have it\. session_send_text — loaded/);
    expect(client.calls[1].toolNames).toContain('session_send_text');
  });

  it('rollback to an unknown checkpoint is an error the model can read, not a rewind', async () => {
    const client = scriptedClient([
      { content: '', tool_calls: [toolCall('rb', 'rollback', '{"label":"nope","note":"n"}')] },
      { content: 'ok' },
    ]);
    await runAgentTurn({ client, system: '', tools: [{ name: 'rollback', description: '', parameters: {} }], history: [], userContent: 'x', executeTool: async () => '', checkpoints: new Map() });
    expect(last(client.calls[1].messages).content).toMatch(/no such checkpoint/);
  });

  it('cleanModelText repairs cp1252 mojibake and strips junk, leaving clean text alone', () => {
    expect(cleanModelText('donâ€™t â€” cafÃ© ðŸ¦Š')).toBe('don’t — café 🦊');
    expect(cleanModelText('a\u0007b�c\r\nd\te')).toBe('abc\nd\te');
    expect(cleanModelText('Ärger über Größe — fine')).toBe('Ärger über Größe — fine');
  });

  it('the model answer reaches history already cleaned', async () => {
    const client = scriptedClient([{ content: 'itâ€™s done' }]);
    const result = await runAgentTurn({ client, system: '', tools: [], history: [], userContent: 'x', executeTool: async () => '' });
    expect(result.finalText).toBe('it’s done');
    expect(last(result.history).content).toBe('it’s done');
  });

  it('parses empty arguments as an empty object and rejects arrays', () => {
    expect(parseToolArguments('')).toEqual({});
    expect(parseToolArguments('[1]')).toBeNull();
  });
});

describe('api prompt helpers', () => {
  it('wraps chat replies to the 140-char line limit and splits at the message limit', () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunkForChat(`${long}\n${'x'.repeat(300)}`, 140, 200);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(200);
      for (const line of chunk.split('\n')) expect(line.length).toBeLessThanOrEqual(140);
    }
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toContain('word0 word1');
    expect(chunks.join('').replace(/\s+/g, '')).toContain('x'.repeat(300));
  });

  it('offers ticked tools in catalog order regardless of tick order (stable cached prefix)', () => {
    const catalog = listAvailableApiTools([
      { name: 'skill_get', title: '', description: 'get', inputSchema: {} },
      { name: 'chat_send', title: '', description: 'send', inputSchema: {} },
    ]);
    const a = selectApiTools(catalog, ['chat_send', 'Grep', 'Read']).map((t) => t.name);
    const b = selectApiTools(catalog, ['Read', 'chat_send', 'Grep']).map((t) => t.name);
    expect(a).toEqual(['Read', 'Grep', 'chat_send']);
    expect(b).toEqual(a);
    expect(selectApiTools(catalog, ['nope'])).toEqual([]);
  });

  it('lists skills by id and name only, and only when skill_get is ticked', () => {
    const skills = [{ id: 's1', name: 'Coding', triggerCondition: 'when coding' }];
    const prompt = buildSystemPrompt({ toolNames: ['skill_get'], skills });
    expect(prompt).toContain('- s1: Coding');
    expect(prompt).not.toContain('when coding');
    expect(buildSystemPrompt({ toolNames: ['Read'], skills })).not.toContain('s1');
  });
});

describe('chat_history', () => {
  const at = Date.parse('2026-09-29T14:00:00Z');
  const entries = Array.from({ length: 30 }, (_, i) => ({ seq: i + 1, at, fromUser: i % 2 === 0, text: i === 4 ? 'the DEPLOY key' : `msg ${i + 1}` }));

  it('shows the newest page oldest-first, both sides labelled, with a pointer to older ones', () => {
    const out = formatChatHistory(entries, { limit: 2 });
    expect(out).toBe('#29 2026-09-29T14:00 user: msg 29\n#30 2026-09-29T14:00 you: msg 30\n(28 older — pass before: 29)');
  });

  it('greps case-insensitively, falls back to plain text for a bad regex, and pages with before', () => {
    expect(formatChatHistory(entries, { query: 'deploy' })).toBe('#5 2026-09-29T14:00 user: the DEPLOY key');
    expect(formatChatHistory([{ seq: 1, at, fromUser: true, text: 'a (b' }], { query: '(b' })).toMatch(/user: a \(b$/);
    expect(formatChatHistory(entries, { before: 3 })).toBe('#1 2026-09-29T14:00 user: msg 1\n#2 2026-09-29T14:00 you: msg 2');
    expect(formatChatHistory(entries, { query: 'nothing' })).toBe('No chat messages match "nothing".');
  });
});

describe('native tools', () => {
  let dir: string;
  const tool = (name: string) => NATIVE_TOOLS.find((t) => t.name === name)!;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-tools-'));
    fs.mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'const a = 1;\nconst b = 2;\n');
    fs.writeFileSync(path.join(dir, 'src', 'deep', 'c.ts'), 'export const c = 3;\n');
    fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'x.ts'), 'const a = 1;\n');
    fs.writeFileSync(path.join(dir, 'README.md'), '# hi\n');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('Glob matches across folders with ** and skips node_modules', async () => {
    const out = await tool('Glob').run({ pattern: '**/*.ts' }, { cwd: dir });
    expect(out.split('\n').sort()).toEqual(['src/a.ts', 'src/deep/c.ts']);
    expect(globToRegExp('*.md').test('README.md')).toBe(true);
    expect(globToRegExp('*.md').test('docs/x.md')).toBe(false);
  });

  it('Grep reports path:line:text and honours the glob filter', async () => {
    const out = await tool('Grep').run({ pattern: 'const [ac]', glob: '**/*.ts' }, { cwd: dir });
    expect(out.split('\n').sort()).toEqual(['src/a.ts:1:const a = 1;', 'src/deep/c.ts:1:export const c = 3;']);
  });

  it('Edit refuses an ambiguous old_string unless replace_all is set', async () => {
    const file = path.join(dir, 'src', 'a.ts');
    expect(await tool('Edit').run({ file_path: file, old_string: 'const', new_string: 'let' }, { cwd: dir })).toMatch(/occurs 2 times/);
    await tool('Edit').run({ file_path: 'src/a.ts', old_string: 'const', new_string: 'let', replace_all: true }, { cwd: dir });
    expect(fs.readFileSync(file, 'utf8')).toBe('let a = 1;\nlet b = 2;\n');
    expect(await tool('Edit').run({ file_path: file, old_string: 'zzz', new_string: 'y' }, { cwd: dir })).toMatch(/not found/);
  });

  it('Read numbers lines and honours offset/limit', async () => {
    expect(await tool('Read').run({ file_path: 'src/a.ts', offset: 2, limit: 1 }, { cwd: dir })).toBe('2\tconst b = 2;');
  });

  it('Write creates parent folders', async () => {
    await tool('Write').run({ file_path: 'new/dir/f.txt', content: 'x' }, { cwd: dir });
    expect(fs.readFileSync(path.join(dir, 'new', 'dir', 'f.txt'), 'utf8')).toBe('x');
  });
});

describe('ApiSessionProcess (terminal adapter)', () => {
  function makeProcess(replies: Result['message'][], overrides: Partial<ConstructorParameters<typeof ApiSessionProcess>[0]> = {}) {
    const client = scriptedClient(replies);
    const saved: Msg[][] = [];
    const outcomes: unknown[] = [];
    const proc = new ApiSessionProcess({
      client, system: 'SYS', tools: [], history: [],
      executeTool: async () => '',
      saveHistory: (h) => saved.push(h),
      mutableContext: () => '<ctx/>',
      onTurnEnd: (o) => outcomes.push(o),
      ...overrides,
    });
    let screen = '';
    proc.onData((d) => { screen += d; });
    return { proc, client, saved, outcomes, screen: () => screen };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('submits a bracketed multi-line paste as ONE turn, with mutable context appended last', async () => {
    const { proc, client, outcomes } = makeProcess([{ content: 'ok' }]);
    proc.start();
    proc.write('\x1b[200~line one\nline two\x1b[201~');
    proc.write('\r');
    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    expect(client.calls).toHaveLength(1);
    expect(last(client.calls[0].messages)).toEqual({ role: 'user', content: 'line one\nline two\n\n<ctx/>' });
  });

  it('handles a paste marker split across writes', async () => {
    const { proc, client, outcomes } = makeProcess([{ content: 'ok' }]);
    proc.write('\x1b[20');
    proc.write('0~a\rb\x1b[201~\r');
    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    // The CR inside the paste is content, not a submit.
    expect(last(client.calls[0].messages).content).toMatch(/^a\rb/);
  });

  it('queues input typed during a turn and runs it after', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const replies = ['first', 'second'];
    const outcomes: Array<{ input: string }> = [];
    const proc = new ApiSessionProcess({
      client: { complete: async () => { if (replies.length === 2) await gate; return { message: { content: replies.shift()! } }; } },
      system: '', tools: [], history: [], executeTool: async () => '', saveHistory: () => {}, mutableContext: () => '',
      onTurnEnd: (o) => outcomes.push(o),
    });
    proc.write('one\r');
    await settle();
    expect(proc.busy).toBe(true);
    proc.write('two\r');
    release();
    await vi.waitFor(() => expect(outcomes.map((o) => o.input)).toEqual(['one', 'two']));
  });

  it('Ctrl+C aborts the running turn and reports it as aborted', async () => {
    const outcomes: Array<{ error?: string }> = [];
    const proc = new ApiSessionProcess({
      client: {
        complete: (_m, _t, signal) => new Promise((_, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted')))),
      },
      system: '', tools: [], history: [], executeTool: async () => '', saveHistory: () => {}, mutableContext: () => '',
      onTurnEnd: (o) => outcomes.push(o),
    });
    proc.write('go\r');
    await settle();
    proc.write('\x03');
    await vi.waitFor(() => expect(outcomes).toEqual([expect.objectContaining({ error: 'aborted' })]));
    expect(proc.busy).toBe(false);
  });

  it('a lone Esc keypress aborts the turn (not held back as a paste-marker fragment)', async () => {
    const outcomes: Array<{ error?: string }> = [];
    const proc = new ApiSessionProcess({
      client: {
        complete: (_m, _t, signal) => new Promise((_, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted')))),
      },
      system: '', tools: [], history: [], executeTool: async () => '', saveHistory: () => {}, mutableContext: () => '',
      onTurnEnd: (o) => outcomes.push(o),
    });
    proc.write('go\r');
    await settle();
    proc.write('\x1b');
    await vi.waitFor(() => expect(outcomes).toEqual([expect.objectContaining({ error: 'aborted' })]));
  });

  it('kill reports exit on a later tick, so session close can remove the row itself (phone close bug)', async () => {
    const { proc } = makeProcess([]);
    const exits: number[] = [];
    proc.onExit((e) => exits.push(e.exitCode));
    proc.kill();
    expect(exits).toEqual([]);
    await settle();
    expect(exits).toEqual([0]);
  });

  it('input sent mid-turn is fed to the model right after the pending tool results', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const client = scriptedClient([
      { content: '', tool_calls: [toolCall('c1', 'Read', '{}')] },
      { content: 'done with both' },
    ]);
    const proc = new ApiSessionProcess({
      client, system: 'SYS', tools: [{ name: 'Read', description: '', parameters: {} }], history: [],
      executeTool: async () => { await gate; return 'file'; },
      saveHistory: () => {}, mutableContext: () => '',
    });
    proc.write('first\r');
    await vi.waitFor(() => expect(client.calls).toHaveLength(1));
    proc.write('also this\r');
    release();
    await vi.waitFor(() => expect(client.calls).toHaveLength(2));
    const roles = client.calls[1].messages.map((m) => `${m.role}:${m.content ?? ''}`);
    expect(roles.slice(-3)).toEqual(['assistant:', 'tool:file', 'user:also this']);
  });

  it('deleting a reply drops the answer and its tool steps but keeps the question; deleting a question drops the turn', () => {
    const history: Msg[] = [
      { role: 'user', content: 'q1\n\n<ctx/>' },
      { role: 'assistant', content: null, tool_calls: [toolCall('c', 'Read', '{}')] },
      { role: 'tool', tool_call_id: 'c', content: 'r' },
      { role: 'assistant', content: 'answer one is long' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'answer two' },
    ];
    expect(dropTurns(history, [{ text: 'answer one', fromUser: false }]).map((m) => m.content))
      .toEqual(['q1\n\n<ctx/>', 'q2', 'answer two']);
    expect(dropTurns(history, [{ text: 'q2', fromUser: true }]).map((m) => m.content))
      .toEqual(['q1\n\n<ctx/>', null, 'r', 'answer one is long']);
    expect(dropTurns(history, [{ text: 'nothing like it', fromUser: true }])).toHaveLength(6);
  });

  it('rescaleTokens scales the last reported size by the history kept', () => {
    const before: Msg[] = [{ role: 'user', content: 'a'.repeat(300) }, { role: 'assistant', content: 'b'.repeat(100) }];
    expect(rescaleTokens(1000, before, before.slice(1))).toBe(250);
    expect(rescaleTokens(undefined, before, [])).toBeUndefined();
  });

  it('forgetNudge fires at 20 past turns, then every 10, and is silent in between', () => {
    const turns = (n: number): Msg[] => Array.from({ length: n }, (_, i) => [
      { role: 'user' as const, content: `q${i}` }, { role: 'assistant' as const, content: `a${i}` },
    ]).flat();
    expect(forgetNudge(turns(19))).toBeNull();
    expect(forgetNudge(turns(20))).toMatch(/20 past turns[\s\S]*forget_turns/);
    expect(forgetNudge(turns(25))).toBeNull();
    expect(forgetNudge(turns(30))).toMatch(/30 past turns/);
  });

  it('/clear wipes the conversation instead of sending it to the model', async () => {
    const { proc, client, saved, outcomes } = makeProcess([{ content: 'fresh' }], { history: [{ role: 'user', content: 'old' }] });
    proc.write('/clear\r');
    proc.write('hi\r');
    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    expect(saved[0]).toEqual([]);
    expect(client.calls[0].messages.map((m) => m.content)).toEqual(['SYS', 'hi\n\n<ctx/>']);
  });

  it('persists history after each completed turn and resumes from it', async () => {
    const { proc, saved, outcomes } = makeProcess([{ content: 'a1' }]);
    proc.write('q1\r');
    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    expect(last(saved).map((m) => m.content)).toEqual(['q1\n\n<ctx/>', 'a1']);

    const resumed = makeProcess([{ content: 'a2' }], { history: last(saved) });
    resumed.proc.write('q2\r');
    await vi.waitFor(() => expect(resumed.outcomes).toHaveLength(1));
    expect(resumed.client.calls[0].messages.map((m) => m.content)).toEqual(['SYS', 'q1\n\n<ctx/>', 'a1', 'q2\n\n<ctx/>']);
  });
});

describe('compact on context full', () => {
  const turn = (n: number): Msg[] => [
    { role: 'user', content: `q${n}` },
    { role: 'assistant', content: null, tool_calls: [toolCall(`c${n}`, 'Read', '{}')] },
    { role: 'tool', tool_call_id: `c${n}`, content: `tool output ${n}` },
    { role: 'assistant', content: `a${n}` },
  ];
  const sixTurns = [1, 2, 3, 4, 5, 6].flatMap(turn);
  const overflow = () => new Error('400: request (70000 tokens) exceeds the available context size (65536 tokens)');

  it('recognises a context-full error and nothing else', () => {
    expect(isContextOverflow(overflow())).toBe(true);
    expect(isContextOverflow(new Error("This model's maximum context length is 8192 tokens"))).toBe(true);
    expect(isContextOverflow(new Error('ECONNREFUSED'))).toBe(false);
  });

  it('forgets every tool call and result, then the oldest third of turns', () => {
    const trimmed = trimForOverflow(sixTurns);
    expect(trimmed.some((m) => m.role === 'tool' || m.tool_calls)).toBe(false);
    expect(trimmed.map((m) => m.content)).toEqual(['q3', 'a3', 'q4', 'a4', 'q5', 'a5', 'q6', 'a6']);
  });

  it('retries the turn after trimming, and the model answers', async () => {
    let failures = 1;
    const sent: Msg[][] = [];
    const outcomes: Array<{ finalText: string; error?: string }> = [];
    const proc = new ApiSessionProcess({
      client: { complete: async (messages: Msg[]) => {
        sent.push(structuredClone(messages));
        if (failures-- > 0) throw overflow();
        return { message: { content: 'fits now' } };
      } },
      system: 'SYS', tools: [], history: structuredClone(sixTurns),
      executeTool: async () => '', saveHistory: () => {}, mutableContext: () => '',
      onTurnEnd: (o) => outcomes.push(o),
    });
    let screen = '';
    proc.onData((d) => { screen += d; });
    proc.write('next\r');
    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    expect(outcomes[0]).toMatchObject({ finalText: 'fits now' });
    expect(outcomes[0].error).toBeUndefined();
    expect(sent[1].some((m) => m.content === 'q1' || m.role === 'tool')).toBe(false);
    expect(screen).toContain('context full');
  });

  it('gives up with the error after three trims', async () => {
    const outcomes: Array<{ error?: string }> = [];
    const proc = new ApiSessionProcess({
      client: { complete: async () => { throw overflow(); } },
      system: 'SYS', tools: [], history: structuredClone(sixTurns),
      executeTool: async () => '', saveHistory: () => {}, mutableContext: () => '',
      onTurnEnd: (o) => outcomes.push(o),
    });
    proc.write('next\r');
    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    expect(outcomes[0].error).toMatch(/context size/);
  });

  it('does not trim on other errors', async () => {
    const saved: Msg[][] = [];
    const outcomes: unknown[] = [];
    const proc = new ApiSessionProcess({
      client: { complete: async () => { throw new Error('ECONNREFUSED'); } },
      system: 'SYS', tools: [], history: structuredClone(sixTurns),
      executeTool: async () => '', saveHistory: (h) => saved.push(h), mutableContext: () => '',
      onTurnEnd: (o) => outcomes.push(o),
    });
    proc.write('next\r');
    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    expect(saved).toEqual([]);
  });
});

describe('ApiSessionHost', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-host-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function makeHost(replies: Result['message'][], extra: Partial<ConstructorParameters<typeof ApiSessionHost>[0]> = {}) {
    const client = scriptedClient(replies);
    const dispatched: Array<{ name: string; args: Record<string, unknown>; sessionId?: string }> = [];
    const hooks: string[] = [];
    const requests: Array<Record<string, unknown>> = [];
    const usages: Array<{ contextTokens: number; toolCalls: number }> = [];
    const host = new ApiSessionHost({
      dispatchTool: async (name, args, auth) => { dispatched.push({ name, args, sessionId: auth.sessionId }); return { ok: true }; },
      // The automatic chat reply, recorded like the chat_send it stands for; its usage badge separately.
      postChat: async (sessionId, message, usage) => {
        dispatched.push({ name: 'chat_send', args: { message }, sessionId });
        usages.push(usage);
      },
      mcpTools: () => [
        { name: 'chat_send', title: '', description: 'send', inputSchema: {} },
        { name: 'memory_search', title: '', description: 'search', inputSchema: {} },
      ],
      listSkills: () => [],
      getMission: () => 'ship it',
      recordToolRequest: (req, auth) => requests.push({ ...req, sessionId: auth.sessionId }),
      emitHook: (e) => hooks.push(`${e.event}${e.toolName ? `:${e.toolName}` : ''}`),
      historyDir: dir,
      createClient: () => client,
      now: () => new Date('2026-09-29T12:00:00Z'),
      createMemory: () => ({ id: 'm' }),
      linkMemory: () => {},
      ...extra,
    });
    return { host, client, dispatched, hooks, requests, usages };
  }
  const api = { baseUrl: 'http://x/v1', model: 'm', allowedTools: ['memory_search', 'Read'], handshake: false };
  const mobileMsg = '[HELM_MSG]{"fromSessionId":"mobile:dev1"}how are you';

  it('auto-replies to chat with the final answer when the model did not call chat_send', async () => {
    const { host, dispatched, hooks, usages } = makeHost([{ reasoning_content: 'one brief thought', content: 'fine thanks' }]);
    const proc = host.create({ sessionId: 's1', sessionName: 'n', cliSessionName: 'abc-1', api });
    proc.write(`${mobileMsg}\r`);
    await vi.waitFor(() => expect(dispatched).toEqual([{ name: 'chat_send', args: { message: 'fine thanks' }, sessionId: 's1' }]));
    expect(hooks).toEqual(['UserPromptSubmit', 'Stop']);
    expect(usages[0]).toMatchObject({ thoughtCount: 1, toolCalls: 0 });
  });

  it('does not double-post when the model replied through chat_send itself', async () => {
    const { host, dispatched, hooks } = makeHost([
      { content: '', tool_calls: [toolCall('c1', 'chat_send', '{"message":"hi from model"}')] },
      { content: 'sent' },
    ]);
    const proc = host.create({ sessionId: 's1', sessionName: 'n', cliSessionName: 'abc-5', api: { ...api, allowedTools: ['chat_send'] } });
    proc.write('hello\r');
    await vi.waitFor(() => expect(hooks).toContain('Stop'));
    await new Promise((r) => setTimeout(r, 10));
    expect(dispatched.map((d) => d.args.message)).toEqual(['hi from model']);
  });

  it('offers only ticked tools, dispatches Helm tools as the session, and fires tool hooks', async () => {
    const { host, client, dispatched, hooks } = makeHost([
      { content: '', tool_calls: [toolCall('c1', 'memory_search', '{"query":"x"}')] },
      { content: 'done' },
    ]);
    const proc = host.create({ sessionId: 's1', sessionName: 'n', cliSessionName: 'abc-2', cwd: dir, api });
    proc.write('find x\r');
    await vi.waitFor(() => expect(hooks).toContain('Stop'));
    expect(client.calls[0].toolNames).toEqual(['Read', 'request_tool', 'chat_history', 'checkpoint', 'rollback', 'forget_turns', 'load_tools']);
    // Helm MCP tools are named in the system prompt, their schemas held back until loaded.
    expect(client.calls[0].messages[0].content).toContain('call them directly (load_tools shows their arguments if you need them): memory_search.');
    expect(dispatched).toEqual([
      { name: 'memory_search', args: { query: 'x' }, sessionId: 's1' },
      { name: 'chat_send', args: { message: 'done' }, sessionId: 's1' },
    ]);
    expect(hooks).toEqual(['UserPromptSubmit', 'PreToolUse:memory_search', 'PostToolUse:memory_search', 'Stop']);
    // Mutable context rides at the end of the user message, never in the system prompt.
    expect(client.calls[0].messages[0].content).not.toContain('2026-09-29');
    expect(client.calls[0].messages[1].content).toMatch(/^find x\n\n<helm_context>[\s\S]*<\/helm_context>$/);
  });

  it('/compact swaps history for the stashed summary, drops the memory, and posts the shrunk context count', async () => {
    const replies = [
      { message: { content: 'long answer '.repeat(50) }, usage: { total_tokens: 1000 } },
      { message: { content: 'SUMMARY: goal X, next Y' }, usage: { total_tokens: 1100 } },
      { message: { content: 'carrying on' }, usage: { total_tokens: 80 } },
    ];
    const calls: Msg[][] = [];
    const client = { complete: async (messages: Msg[]) => { calls.push(structuredClone(messages)); return replies.shift()!; } };
    const { host, dispatched, hooks, usages } = makeHost([], { createClient: () => client as never });
    const proc = host.create({ sessionId: 's1', sessionName: 'n', cliSessionName: 'abc-c', api });
    proc.write('do the thing\r');
    await vi.waitFor(() => expect(hooks).toContain('Stop'));
    proc.write('/compact keep ids\r');
    await vi.waitFor(() => expect(dispatched.map((d) => d.name)).toContain('memory_delete'));
    expect(last(calls[1]).content).toMatch(/^Compact your context[\s\S]*Focus on: keep ids$/);
    expect(dispatched.find((d) => d.name === 'memory_delete')!.args).toEqual({ id: 'm' });
    await vi.waitFor(() => expect(dispatched.map((d) => d.args.message)).toContain('(context compacted)'));
    const compactedUsage = last(usages).contextTokens;
    expect(compactedUsage).toBeGreaterThan(0);
    expect(compactedUsage).toBeLessThan(1100);
    proc.write('go on\r');
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2].slice(1).map((m) => m.content)).toEqual([
      '[Handover — your summary of the conversation before compaction]\nSUMMARY: goal X, next Y',
      'Understood — continuing from the summary.',
      expect.stringMatching(/^go on/),
    ]);
  });

  it('deleting chat bubbles between turns posts the shrunk context count', async () => {
    const replies = [
      { message: { content: 'answer one' }, usage: { total_tokens: 400 } },
      { message: { content: 'answer two' }, usage: { total_tokens: 800 } },
    ];
    const client = { complete: async () => replies.shift()! };
    const { host, hooks, dispatched, usages } = makeHost([], { createClient: () => client as never });
    const proc = host.create({ sessionId: 's1', sessionName: 'n', cliSessionName: 'abc-d', api });
    proc.write('question one\r');
    await vi.waitFor(() => expect(hooks.filter((h) => h === 'Stop')).toHaveLength(1));
    proc.write('question two\r');
    await vi.waitFor(() => expect(hooks.filter((h) => h === 'Stop')).toHaveLength(2));
    host.forgetMessages('s1', [{ text: 'question one', fromUser: true }]);
    await vi.waitFor(() => expect(dispatched.map((d) => d.args.message)).toContain('(deleted from context)'));
    expect(last(usages).contextTokens).toBeLessThan(800);
    expect(last(usages).contextTokens).toBeGreaterThan(0);
  });

  it('handshake: a fresh conversation\'s first turn has no tools; the confirming next turn does', async () => {
    const { host, client, hooks } = makeHost([{ content: 'I will search for x' }, { content: 'done' }]);
    const proc = host.create({ sessionId: 's1', sessionName: 'n', cliSessionName: 'abc-h', api: { ...api, handshake: true } });
    proc.write('find x\r');
    await vi.waitFor(() => expect(hooks.filter((h) => h === 'Stop')).toHaveLength(1));
    expect(client.calls[0].toolNames).toEqual([]);
    expect(client.calls[0].messages[1].content).toMatch(/tools are off for this reply/);
    proc.write('yes go\r');
    await vi.waitFor(() => expect(hooks.filter((h) => h === 'Stop')).toHaveLength(2));
    expect(client.calls[1].toolNames).toContain('Read');
    expect(last(client.calls[1].messages).content).not.toMatch(/tools are off/);
  });

  it('forget_turns drops the quoted past turn after the current one', async () => {
    const { host, client, hooks } = makeHost([
      { content: 'first answer' },
      { content: '', tool_calls: [toolCall('f', 'forget_turns', '{"messages":[{"text":"old question","fromUser":true}]}')] },
      { content: 'pruned' },
      { content: 'third' },
    ]);
    const proc = host.create({ sessionId: 's1', sessionName: 'n', cliSessionName: 'abc-f', api });
    proc.write('old question\r');
    await vi.waitFor(() => expect(hooks.filter((h) => h === 'Stop')).toHaveLength(1));
    proc.write('prune please\r');
    await vi.waitFor(() => expect(hooks.filter((h) => h === 'Stop')).toHaveLength(2));
    expect(last(client.calls[2].messages).content).toBe('1 message(s) will be forgotten after this turn.');
    proc.write('next\r');
    await vi.waitFor(() => expect(hooks.filter((h) => h === 'Stop')).toHaveLength(3));
    const sent = client.calls[3].messages.map((m) => m.content ?? '');
    expect(sent.some((c) => c.startsWith('old question'))).toBe(false);
    expect(sent.some((c) => c.startsWith('prune please'))).toBe(true);
  });

  it('appends the hook prompt context after the mutable context, given the real prompt', async () => {
    const asked: Array<[string, string]> = [];
    let offeredTools: ReadonlySet<string> = new Set();
    const { host, client, hooks } = makeHost([{ content: 'ok' }], {
      promptContext: async (sessionId, prompt, tools) => {
        asked.push([sessionId, prompt]);
        offeredTools = tools;
        return 'possibly related: memory/m1 (Thing)';
      },
    });
    const proc = host.create({ sessionId: 's1', sessionName: 'n', cliSessionName: 'abc-pc', api });
    proc.write('find x\r');
    await vi.waitFor(() => expect(hooks).toContain('Stop'));
    expect(asked).toEqual([['s1', 'find x']]);
    expect([...offeredTools].sort()).toEqual(['Read', 'chat_history', 'checkpoint', 'forget_turns', 'memory_search', 'request_tool', 'rollback']);
    expect(client.calls[0].messages[1].content).toMatch(/<\/helm_context>\n\npossibly related: memory\/m1 \(Thing\)$/);
  });

  it('still runs the turn when the prompt context throws', async () => {
    const { host, client, hooks } = makeHost([{ content: 'ok' }], {
      promptContext: async () => { throw new Error('boom'); },
    });
    const proc = host.create({ sessionId: 's1', sessionName: 'n', cliSessionName: 'abc-pt', api });
    proc.write('find x\r');
    await vi.waitFor(() => expect(hooks).toContain('Stop'));
    expect(client.calls[0].messages[1].content).toMatch(/<\/helm_context>$/);
  });

  it('refuses a tool that was not ticked even if the model names it', async () => {
    const { host, client, dispatched } = makeHost([
      { content: '', tool_calls: [toolCall('c1', 'chat_send', '{"message":"sneaky"}')] },
      { content: 'ok' },
    ]);
    const proc = host.create({ sessionId: 's1', sessionName: 'n', cliSessionName: 'abc-3', api });
    proc.write('hi\r');
    await vi.waitFor(() => expect(client.calls).toHaveLength(2));
    expect(dispatched.map((d) => d.args.message)).toEqual(['ok']);
    expect(last(client.calls[1].messages).content).toMatch(/not available/);
  });

  it('routes the final answer back to a Helm session that awaits a reply, not to chat', async () => {
    const { host, dispatched } = makeHost([{ content: 'build is green' }]);
    const proc = host.create({ sessionId: 's1', sessionName: 'n', cliSessionName: 'abc-7', api });
    proc.write(`${formatSenderTag({ sessionId: 'peer-1', sessionName: 'orchestrator', awaitingReply: true })}status?\r`);
    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    expect(dispatched[0]).toEqual({
      name: 'session_send_text',
      args: { sessionId: 'peer-1', senderSessionId: 's1', text: 'build is green' },
      sessionId: 's1',
    });
  });

  it('a message from a session that does not await a reply is answered to chat', async () => {
    const { host, dispatched } = makeHost([{ content: 'noted' }]);
    const proc = host.create({ sessionId: 's1', sessionName: 'n', cliSessionName: 'abc-8', api });
    proc.write(`${formatSenderTag({ sessionId: 'peer-1', sessionName: 'orchestrator', awaitingReply: false })}fyi\r`);
    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    expect(dispatched[0].name).toBe('chat_send');
  });

  it('request_tool is always offered, files the wish and pings chat, then tells the model to carry on', async () => {
    const { host, client, dispatched, requests } = makeHost([
      { content: '', tool_calls: [toolCall('c1', 'request_tool', '{"name":"HttpGet","purpose":"fetch a URL","example":"{\\"url\\":\\"x\\"}"}')] },
      { content: 'ok, without it' },
    ]);
    const proc = host.create({ sessionId: 's1', sessionName: 'mini', cliSessionName: 'abc-6', api: { ...api, allowedTools: [] } });
    proc.write('get example.com\r');
    await vi.waitFor(() => expect(client.calls).toHaveLength(2));
    expect(client.calls[0].toolNames).toEqual(['request_tool', 'chat_history', 'checkpoint', 'rollback', 'forget_turns']);
    expect(requests).toEqual([{ name: 'HttpGet', purpose: 'fetch a URL', example: '{"url":"x"}', sessionId: 's1' }]);
    expect(dispatched[0]).toEqual({ name: 'chat_send', args: { message: 'mini requests a new tool: HttpGet\nfetch a URL' }, sessionId: 's1' });
    expect(last(client.calls[1].messages).content).toMatch(/carry on without it/);
  });

  it('quick compacts API history into a readable pointer while retaining linked raw archives', async () => {
    const history: Msg[] = [
      { role: 'user', content: 'read the config' },
      { role: 'assistant', content: null, tool_calls: [toolCall('read-1', 'Read', '{"file_path":"config.json"}') ] },
      { role: 'tool', tool_call_id: 'read-1', content: 'successful output that should stay in the raw archive' },
      { role: 'assistant', content: 'The config is valid.' },
      { role: 'user', content: 'check the other file' },
      { role: 'assistant', content: null, tool_calls: [toolCall('read-2', 'Read', '{"file_path":"missing.json"}') ] },
      { role: 'tool', tool_call_id: 'read-2', content: 'Error: file not found' },
      { role: 'assistant', content: 'The second file is missing.' },
    ];
    fs.writeFileSync(path.join(dir, 'qc-1.json'), JSON.stringify(history));
    const calls: Array<{ messages: Msg[]; toolNames: string[] }> = [];
    let replies: Result['message'][] = [];
    const client = {
      calls,
      complete: async (messages: Msg[], tools: Array<{ name: string }>) => {
        calls.push({ messages: structuredClone(messages), toolNames: tools.map((tool) => tool.name) });
        const next = replies.shift();
        if (!next) throw new Error('script exhausted');
        return { message: next };
      },
    };
    const { host, dispatched } = makeHost([], { createClient: () => client as never });
    const proc = host.create({ sessionId: 's1', sessionName: 'n', cliSessionName: 'qc-1', api });

    const first = await host.quickCompactSession('s1', 'keep the ids');
    expect(first.queued).toBe(false);
    if (first.queued) throw new Error('quick compact unexpectedly queued');
    expect(JSON.parse(fs.readFileSync(first.archiveFile, 'utf8'))).toEqual(history);
    const readable = fs.readFileSync(first.transcriptFile, 'utf8');
    expect(readable).toContain('read the config');
    expect(readable).toContain('Read({"file_path":"config.json"})');
    expect(readable).toContain('Error: file not found');
    expect(readable).not.toContain('successful output that should stay in the raw archive');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'qc-1.json'), 'utf8'))[0].content)
      .toContain(`at: ${first.transcriptFile}`);
    const compactedHistory = JSON.parse(fs.readFileSync(path.join(dir, 'qc-1.json'), 'utf8')) as Msg[];
    expect(compactedHistory).toHaveLength(2);
    expect(compactedHistory[0].content).toContain('Handover note: keep the ids');

    // The configured native Read tool can load the persisted transcript on the next turn.
    replies = [
      { content: '', tool_calls: [toolCall('reload', 'Read', JSON.stringify({ file_path: first.transcriptFile }))] },
      { content: 'continued from the transcript' },
    ];
    proc.write('continue\r');
    await vi.waitFor(() => expect(dispatched.map((item) => item.args.message)).toContain('continued from the transcript'));
    expect(client.calls[0].toolNames).toContain('Read');
    expect(client.calls[1].messages.at(-1)?.content).toContain('read the config');

    const second = await host.quickCompactSession('s1');
    expect(second.queued).toBe(false);
    if (second.queued) throw new Error('second quick compact unexpectedly queued');
    expect(fs.existsSync(first.archiveFile)).toBe(true);
    expect(fs.readFileSync(second.transcriptFile, 'utf8')).toContain(first.transcriptFile);
  });

  it('invalidates checkpoints and updates context usage after quick compact', async () => {
    const replies: Result['message'][] = [
      { content: '', tool_calls: [toolCall('cp', 'checkpoint', '{"label":"before"}')] },
      { content: 'answer '.repeat(200) },
    ];
    const calls: Array<{ messages: Msg[]; toolNames: string[] }> = [];
    const client = {
      complete: async (messages: Msg[], tools: Array<{ name: string }>) => {
        calls.push({ messages: structuredClone(messages), toolNames: tools.map((tool) => tool.name) });
        const message = replies.shift();
        if (!message) throw new Error('script exhausted');
        return { message, usage: { total_tokens: 1300 } };
      },
    };
    const { host, hooks, usages, dispatched } = makeHost([], { createClient: () => client as never });
    const proc = host.create({ sessionId: 's1', sessionName: 'n', cliSessionName: 'qc-checkpoint', api });
    proc.write(`${'large question '.repeat(80)}\r`);
    await vi.waitFor(() => expect(hooks).toContain('Stop'));

    const compacted = await host.quickCompactSession('s1');
    expect(compacted.queued).toBe(false);
    expect(dispatched.map((item) => item.args.message)).toContain('(context compacted)');
    expect(usages.at(-1)?.contextTokens).toBeGreaterThan(0);
    expect(usages.at(-1)?.contextTokens).toBeLessThan(1300);

    replies.push(
      { content: '', tool_calls: [toolCall('rb', 'rollback', '{"label":"before","note":"stale checkpoint"}')] },
      { content: 'continuing without the stale checkpoint' },
    );
    proc.write('try the old checkpoint\r');
    await vi.waitFor(() => expect(hooks.filter((hook) => hook === 'Stop')).toHaveLength(2));
    expect(calls[3].messages.at(-1)?.content).toMatch(/no such checkpoint/);
  });

  it('requires Read and leaves history unchanged when archive creation fails', async () => {
    const history: Msg[] = [{ role: 'user', content: 'original question' }];
    fs.writeFileSync(path.join(dir, 'qc-no-read.json'), JSON.stringify(history));
    const noRead = makeHost(scriptedClient([{ content: 'done' }])).host;
    noRead.create({ sessionId: 'no-read', sessionName: 'n', cliSessionName: 'qc-no-read', api: { ...api, allowedTools: [] } });
    await expect(noRead.quickCompactSession('no-read')).rejects.toThrow(/Read tool/);
    expect(fs.readFileSync(path.join(dir, 'qc-no-read.json'), 'utf8')).toBe(JSON.stringify(history));

    const blockedDir = path.join(dir, 'not-a-directory');
    fs.writeFileSync(blockedDir, 'blocked');
    const blockedClient = scriptedClient([{ content: 'first answer' }, { content: 'second answer' }]);
    const blockedHost = new ApiSessionHost({
      dispatchTool: async () => ({}), createMemory: () => ({ id: 'm' }), linkMemory: () => {},
      postChat: async () => ({}), mcpTools: () => [], listSkills: () => [], getMission: () => undefined,
      recordToolRequest: () => {}, emitHook: () => {}, historyDir: blockedDir,
      createClient: () => blockedClient as never,
    });
    const blockedProc = blockedHost.create({ sessionId: 'blocked', sessionName: 'n', cliSessionName: 'blocked-1', api });
    blockedProc.write('first question\r');
    await vi.waitFor(() => expect(blockedProc.busy).toBe(false));
    await expect(blockedHost.quickCompactSession('blocked')).rejects.toThrow();
    blockedProc.write('second question\r');
    await vi.waitFor(() => expect(blockedClient.calls).toHaveLength(2));
    // The archive write failed before changing the in-memory canonical history.
    const retryHistory = blockedClient.calls[1].messages;
    expect(retryHistory.at(-3)?.content).toMatch(/^first question/);
    expect(retryHistory.at(-2)?.content).toBe('first answer');
    expect(retryHistory.at(-1)?.content).toMatch(/^second question/);
  });

  it('keeps in-memory history when the atomic replacement write fails', async () => {
    // A directory at the history filename lets archive files succeed but makes
    // the final temp-file rename fail, exercising the commit boundary itself.
    fs.mkdirSync(path.join(dir, 'persist-fail.json'));
    const client = scriptedClient([{ content: 'first answer' }, { content: 'second answer' }]);
    const { host, hooks } = makeHost([], { createClient: () => client as never });
    const proc = host.create({ sessionId: 'persist-fail', sessionName: 'n', cliSessionName: 'persist-fail', api });
    proc.write('first question\r');
    await vi.waitFor(() => expect(hooks).toContain('Stop'));

    await expect(host.quickCompactSession('persist-fail')).rejects.toThrow();
    expect(fs.readdirSync(dir).filter((name) => name.startsWith('persist-fail.') && name.includes('quick-compact'))).toEqual([]);

    proc.write('second question\r');
    await vi.waitFor(() => expect(client.calls).toHaveLength(2));
    expect(client.calls[1].messages.at(-3)?.content).toMatch(/^first question/);
    expect(client.calls[1].messages.at(-2)?.content).toBe('first answer');
    expect(client.calls[1].messages.at(-1)?.content).toMatch(/^second question/);
  });

  it('queues quick compact until the running API turn has committed its answer', async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const requestStarted = new Promise<void>((resolve) => { started = resolve; });
    const client = { complete: async () => { started(); await gate; return { message: { content: 'committed answer' } }; } };
    const { host } = makeHost([], { createClient: () => client as never });
    const proc = host.create({ sessionId: 's1', sessionName: 'n', cliSessionName: 'qc-busy', api });
    proc.write('active question\r');
    await requestStarted;

    await expect(host.quickCompactSession('s1', 'queued note')).resolves.toEqual({ queued: true });
    release();
    const historyFile = path.join(dir, 'qc-busy.json');
    await vi.waitFor(() => {
      const history = JSON.parse(fs.readFileSync(historyFile, 'utf8')) as Msg[];
      expect(history[0].content).toContain('.quick-compact.md');
    });
    const archive = fs.readdirSync(dir).find((name) => name.endsWith('.quick-compact.json'))!;
    const archivedHistory = JSON.parse(fs.readFileSync(path.join(dir, archive), 'utf8')) as Msg[];
    expect(archivedHistory.map((message) => message.content)).toContain('committed answer');
  });

  it('resumes a session from its persisted history file', async () => {
    const first = makeHost([{ content: 'remembered' }]);
    const proc = first.host.create({ sessionId: 's1', sessionName: 'n', cliSessionName: 'abc-4', api });
    proc.write('remember this\r');
    await vi.waitFor(() => expect(first.hooks).toContain('Stop'));

    const second = makeHost([{ content: 'yes' }]);
    const resumed = second.host.create({ sessionId: 's1', sessionName: 'n', cliSessionName: 'abc-4', api });
    resumed.write('recall\r');
    await vi.waitFor(() => expect(second.client.calls).toHaveLength(1));
    expect(second.client.calls[0].messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });
});

describe('sender tag', () => {
  it('round-trips, keeps names with spaces, and ignores ordinary text', () => {
    const tag = { sessionId: 'a1b2-c3', sessionName: 'my worker (2)', awaitingReply: true };
    expect(parseSenderTag(`${formatSenderTag(tag)}hello`)).toEqual(tag);
    expect(parseSenderTag(`${formatSenderTag({ ...tag, awaitingReply: false })}x`)?.awaitingReply).toBe(false);
    expect(parseSenderTag('hello [from x (y)] later')).toBeNull();
  });
});

describe('ApiSessionHost — subagents and slots', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-sub-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const api = { baseUrl: 'http://x/v1', model: 'm', allowedTools: ['Read'], handshake: false };

  function makeHost(client: { complete: (...a: any[]) => Promise<any> }) {
    const chat: string[] = [];
    const closed: string[] = [];
    const memories: Array<{ id: string; owner: string; tldr: string; content: string; agentRun: boolean; summary: boolean }> = [];
    const links: Array<[string, string]> = [];
    const pending: Array<[string, number]> = [];
    let n = 0;
    const host: InstanceType<typeof ApiSessionHost> = new ApiSessionHost({
      // session_create spawns the child exactly as Helm would: through the host.
      dispatchTool: async (name, args) => {
        if (name === 'session_close') { closed.push(String(args.sessionId)); return { ok: true }; }
        if (name !== 'session_create') return {};
        const id = `child-${++n}`;
        host.create({ sessionId: id, sessionName: String(args.name), cliSessionName: `c-${n}`, cliType: 't1', api });
        return { id };
      },
      createMemory: (owner, input) => {
        const id = `m${memories.length + 1}`;
        memories.push({ id, owner, ...input });
        return { id };
      },
      linkMemory: (_owner, from, to) => { links.push([from, to]); },
      onPendingSubagents: (sessionId, count) => { pending.push([sessionId, count]); },
      postChat: async (_s, message) => { chat.push(message); },
      mcpTools: () => [{ name: 'memory_get', title: '', description: 'get', inputSchema: {} }],
      listSkills: () => [],
      getMission: () => 'ship it',
      recordToolRequest: () => {},
      emitHook: () => {},
      historyDir: dir,
      createClient: () => client as any,
    });
    return { host, chat, closed, memories, links, pending };
  }

  it('a subagent files summary + detail memories, the parent gets only the header, and the child closes', async () => {
    const client = scriptedClient([
      { content: '', tool_calls: [toolCall('a1', 'Agent', '{"tasks":[{"description":"count docs","prompt":"How many md files in docs?"}]}')] },
      { content: 'docs has 49 md files: a.md, b.md, ...' },
      { content: 'There are 49 md files in docs.' },
      { content: 'The subagent says 49.' },
    ]);
    const { host, chat, closed, memories, links, pending } = makeHost(client);
    host.create({ sessionId: 'p1', sessionName: 'boss', cliSessionName: 'p-1', cliType: 't1', api }).write('delegate it\r');
    await vi.waitFor(() => expect(chat).toEqual(['The subagent says 49.']));

    const [parentFirst, childFirst, childSummary, parentSecond] = client.calls;
    // Same system prompt and tool block as the parent, so the prefix cache is shared.
    expect(childFirst.messages[0]).toEqual(parentFirst.messages[0]);
    expect(childFirst.toolNames).toEqual(parentFirst.toolNames);
    expect(parentFirst.toolNames).toEqual(['Read', 'request_tool', 'chat_history', 'checkpoint', 'rollback', 'forget_turns', 'Agent', 'load_tools']);
    expect(childFirst.messages[1].content).toMatch(/^Handover from boss — subagent task: count docs\nParent mission: ship it\n\nHow many md files in docs\?/);
    // The subagent writes its own summary in one more turn.
    expect(last(childSummary.messages).content).toMatch(/^Summarise your result/);

    expect(memories).toEqual([
      { id: 'm1', owner: 'child-1', tldr: 'count docs — detail', content: 'docs has 49 md files: a.md, b.md, ...', agentRun: true, summary: false },
      { id: 'm2', owner: 'child-1', tldr: 'count docs', content: 'There are 49 md files in docs.', agentRun: true, summary: true },
    ]);
    expect(links).toEqual([['m2', 'm1']]);
    // Only the header travels back; the detail stays behind the pointer.
    const toolResult = last(parentSecond.messages).content!;
    expect(toolResult).toContain('result memory m2');
    expect(toolResult).toContain('There are 49 md files in docs.');
    expect(toolResult).not.toContain('a.md');
    expect(closed).toEqual(['child-1']);
    expect(host.parentOf('child-1')).toBe('p1');
    // The 🔥 count rises while the subagent works and returns to 0.
    expect(pending).toEqual([['p1', 1], ['p1', 0]]);
    expect(host.parentOf('p1')).toBeUndefined();
  });

  it('one Agent call runs a batch of tasks and returns their results in task order', async () => {
    const client = scriptedClient([
      { content: '', tool_calls: [toolCall('a1', 'Agent', '{"tasks":[{"description":"one","prompt":"p1"},{"description":"two","prompt":"p2"}]}')] },
      { content: 'r' }, { content: 'r' }, { content: 's' }, { content: 's' },
      { content: 'both done' },
    ]);
    const { host, chat, closed } = makeHost(client);
    host.create({ sessionId: 'p1', sessionName: 'boss', cliSessionName: 'p-b', cliType: 't1', api }).write('fan out\r');
    await vi.waitFor(() => expect(chat).toEqual(['both done']));
    expect(closed).toHaveLength(2);
    const toolResult = last(last(client.calls).messages).content!;
    expect(toolResult).toMatch(/^\[1\] [\s\S]*\n\n\[2\] /);
  });

  it('an Agent call without tasks is an error the model can read', async () => {
    const client = scriptedClient([
      { content: '', tool_calls: [toolCall('a1', 'Agent', '{"description":"old","prompt":"form"}')] },
      { content: 'ok' },
    ]);
    const { host, chat } = makeHost(client);
    host.create({ sessionId: 'p1', sessionName: 'boss', cliSessionName: 'p-e', cliType: 't1', api }).write('go\r');
    await vi.waitFor(() => expect(chat).toEqual(['ok']));
    expect(last(client.calls[1].messages).content).toMatch(/^Error: tasks must be a non-empty array/);
  });

  it('subagents nest up to 3 deep through one slot; summaries link down the tree; a 4th level is refused', async () => {
    const agent = (id: string) => ({ content: '', tool_calls: [toolCall(id, 'Agent', `{"tasks":[{"description":"level ${id}","prompt":"go deeper"}]}`)] });
    const client = scriptedClient([
      agent('1'), agent('2'), agent('3'), agent('4'),
      { content: 'leaf did it' }, { content: 'leaf summary' },
      { content: 'depth 2 done' }, { content: 'depth 2 summary' },
      { content: 'depth 1 done' }, { content: 'depth 1 summary' },
      { content: 'root done' },
    ]);
    const { host, chat, memories, links } = makeHost(client);
    host.create({ sessionId: 'p1', sessionName: 'boss', cliSessionName: 'p-2', cliType: 't1', api }).write('go\r');
    await vi.waitFor(() => expect(chat).toEqual(['root done']));
    // The 4th Agent call (made at depth 3) was refused.
    expect(last(client.calls[4].messages).content).toMatch(/nest only 3 deep/);
    const summaryId = (text: string) => memories.find((m) => m.summary && m.content === text)!.id;
    // Each summary points at its own detail and at the summary of the subagent it ran.
    expect(links).toContainEqual([summaryId('depth 2 summary'), summaryId('leaf summary')]);
    expect(links).toContainEqual([summaryId('depth 1 summary'), summaryId('depth 2 summary')]);
    expect(last(client.calls[10].messages).content).toContain('depth 1 summary');
  });

  it('reads the API key from the type\'s own env entries before the process env', () => {
    const keys: Array<string | undefined> = [];
    const host = new ApiSessionHost({
      dispatchTool: async () => ({}), postChat: async () => {}, createMemory: () => ({ id: 'm' }), linkMemory: () => {},
      mcpTools: () => [], listSkills: () => [], getMission: () => undefined, recordToolRequest: () => {}, emitHook: () => {},
      historyDir: dir, env: { ZAI_API_KEY: 'from-process' },
      createClient: (_api, key) => { keys.push(key); return { complete: async () => ({ message: { content: '' } }) }; },
    });
    const keyed = { ...api, apiKeyEnv: 'ZAI_API_KEY' };
    host.create({ sessionId: 'k1', sessionName: 'k', cliSessionName: 'k-1', api: keyed, env: { ZAI_API_KEY: 'from-type' } });
    host.create({ sessionId: 'k2', sessionName: 'k', cliSessionName: 'k-2', api: keyed });
    expect(keys).toEqual(['from-type', 'from-process']);
  });

  it('slots cap in-flight requests per API tool; extra requests queue', async () => {
    for (const slots of [1, 2]) {
      let inFlight = 0;
      let peak = 0;
      const client = {
        complete: async () => {
          peak = Math.max(peak, ++inFlight);
          await new Promise((r) => setTimeout(r, 20));
          inFlight--;
          return { message: { content: 'ok' } };
        },
      };
      const { host, chat } = makeHost(client);
      for (const id of ['a', 'b', 'c']) {
        host.create({ sessionId: id, sessionName: id, cliSessionName: `s-${id}-${slots}`, cliType: 't1', api: { ...api, slots } }).write('go\r');
      }
      await vi.waitFor(() => expect(chat).toHaveLength(3));
      expect(peak).toBe(slots);
    }
  });
});
