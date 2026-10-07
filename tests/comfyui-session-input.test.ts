import { describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { ComfyUiSessionHost } from '../src/session/comfyui/comfyui-session-host.js';
import { cloneDefaultComfyUiConfigForKind } from '../src/session/comfyui/comfyui-config.js';

describe('ComfyUI session input', () => {
  it('does not turn generic PTY writes into generation jobs', () => {
    const postChat = vi.fn(async () => undefined);
    const host = new ComfyUiSessionHost({
      tempDir: tmpdir(),
      artifacts: {
        getForSession: () => [],
        create: () => ({}) as never,
      },
      attachments: {
        addGeneratedMediaFromFile: async () => ({}) as never,
        getPath: () => '',
      },
      postChat,
    });
    const process = host.create('session-1', cloneDefaultComfyUiConfigForKind('image'));

    process.write('a reminder must not render\r');

    expect(postChat).not.toHaveBeenCalled();
    process.kill();
  });
});
