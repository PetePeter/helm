import { describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { ComfyUiSessionHost } from '../src/session/comfyui/comfyui-session-host.js';
import { cloneDefaultComfyUiConfigForKind, COMFYUI_IMAGE_SIZE_OPTIONS } from '../src/session/comfyui/comfyui-config.js';

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

  it('exposes model workflows and image size options independently to chat clients', () => {
    const host = new ComfyUiSessionHost({
      tempDir: tmpdir(),
      artifacts: { getForSession: () => [], create: () => ({}) as never },
      attachments: { addGeneratedMediaFromFile: async () => ({}) as never, getPath: () => '' },
      postChat: vi.fn(async () => undefined),
    });
    const process = host.create('session-2', cloneDefaultComfyUiConfigForKind('image'));

    expect(process.profiles.map(profile => profile.id)).toEqual([
      'image', 'image-lustify-v8-apex', 'image-z-image-turbo', 'image-qwen-image-2-1',
    ]);
    expect(process.profiles.map(profile => profile.supportsImageSize)).toEqual([true, true, true, true]);
    expect(process.imageSizes).toEqual(COMFYUI_IMAGE_SIZE_OPTIONS);
    process.kill();
  });

  it('does not expose the image picker for video-only tools', () => {
    const host = new ComfyUiSessionHost({
      tempDir: tmpdir(),
      artifacts: { getForSession: () => [], create: () => ({}) as never },
      attachments: { addGeneratedMediaFromFile: async () => ({}) as never, getPath: () => '' },
      postChat: vi.fn(async () => undefined),
    });
    const process = host.create('session-3', cloneDefaultComfyUiConfigForKind('video'));

    expect(process.profiles.every(profile => profile.kind === 'video' && !profile.supportsImageSize)).toBe(true);
    expect(process.imageSizes).toEqual([]);
    process.kill();
  });
});
