import { describe, expect, it } from 'vitest';
import { createOpenAiChatClient } from '../src/session/api/api-agent-loop.js';

function captureBody(temperature?: number): Promise<Record<string, unknown>> {
  let sent: Record<string, unknown> = {};
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }));
  }) as unknown as typeof fetch;
  const client = createOpenAiChatClient({ baseUrl: 'http://x/v1', model: 'm', temperature, fetchImpl });
  return client.complete([{ role: 'user', content: 'yo' }], [], new AbortController().signal).then(() => sent);
}

describe('createOpenAiChatClient temperature', () => {
  it('sends the configured temperature, including 0', async () => {
    expect((await captureBody(1)).temperature).toBe(1);
    expect((await captureBody(0)).temperature).toBe(0);
  });

  it('omits temperature when unset so the server default applies', async () => {
    expect(await captureBody()).not.toHaveProperty('temperature');
  });
});
