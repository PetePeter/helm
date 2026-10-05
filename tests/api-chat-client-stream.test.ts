import { describe, expect, it } from 'vitest';
import { createOpenAiChatClient } from '../src/session/api/api-agent-loop.js';

function sse(...events: unknown[]): Response {
  const text = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
  // Split mid-line to exercise the cross-chunk buffer.
  const mid = Math.floor(text.length / 2);
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) { c.enqueue(enc.encode(text.slice(0, mid))); c.enqueue(enc.encode(text.slice(mid))); c.close(); },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

const clientFor = (res: Response) =>
  createOpenAiChatClient({ baseUrl: 'http://x/v1', model: 'm', fetchImpl: (async () => res) as unknown as typeof fetch });

describe('createOpenAiChatClient streaming', () => {
  it('folds content, reasoning, finish reason and usage deltas', async () => {
    const out = await clientFor(sse(
      { choices: [{ delta: { reasoning_content: 'th' } }] },
      { choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } },
      '[DONE]',
    )).complete([], []);
    expect(out.message).toEqual({ content: 'Hello', reasoning_content: 'th' });
    expect(out.finishReason).toBe('stop');
    expect(out.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2 });
  });

  it('assembles tool calls whose arguments arrive in fragments', async () => {
    const out = await clientFor(sse(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'Glob', arguments: '{"pat' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'tern":"*.md"}' } }] }, finish_reason: 'tool_calls' }] },
    )).complete([], []);
    expect(out.message.tool_calls).toEqual([
      { id: 'c1', type: 'function', function: { name: 'Glob', arguments: '{"pattern":"*.md"}' } },
    ]);
  });

  it('still accepts a plain JSON reply from servers that ignore stream', async () => {
    const res = new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
    expect((await clientFor(res).complete([], [])).message.content).toBe('ok');
  });
});
