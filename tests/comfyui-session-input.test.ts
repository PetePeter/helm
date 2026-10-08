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
    expect(process.profiles.find(profile => profile.id === 'image-qwen-image-2-1')?.maxReferenceImages).toBe(16);
    expect(process.profiles.find(profile => profile.id === 'image')?.maxReferenceImages).toBe(2);
    process.kill();
  });

  it('rejects more references than the selected workflow accepts before reading files', () => {
    const getAttachment = vi.fn(() => null);
    const host = new ComfyUiSessionHost({
      tempDir: tmpdir(),
      artifacts: { getForSession: () => [{ id: 'chat-files', title: 'Chat files' }] as never, create: () => ({}) as never },
      attachments: {
        add: () => ({}) as never,
        addGeneratedMediaFromFile: async () => ({}) as never,
        get: getAttachment,
        getPath: () => '',
      },
      postChat: vi.fn(async () => undefined),
    });
    const process = host.create('session-4', cloneDefaultComfyUiConfigForKind('image'));

    expect(() => host.submit('session-4', '', 'image', undefined, undefined, undefined, ['one', 'two', 'three']))
      .toThrow('accepts at most 2 reference images');
    expect(getAttachment).not.toHaveBeenCalled();
    process.kill();
  });

  it('does not queue an image-only request when its gallery reference is unavailable', () => {
    const getAttachment = vi.fn(() => null);
    const postChat = vi.fn(async () => undefined);
    const host = new ComfyUiSessionHost({
      tempDir: tmpdir(),
      artifacts: { getForSession: () => [{ id: 'chat-files', title: 'Chat files' }] as never, create: () => ({}) as never },
      attachments: {
        add: () => ({}) as never,
        addGeneratedMediaFromFile: async () => ({}) as never,
        get: getAttachment,
        getPath: () => '',
      },
      postChat,
    });
    const process = host.create('session-5', cloneDefaultComfyUiConfigForKind('image'));

    expect(() => host.submit('session-5', '', 'image-qwen-image-2-1', undefined, undefined, undefined, ['missing']))
      .toThrow('A selected reference image is no longer available in this session');
    expect(getAttachment).toHaveBeenCalledWith('chat-files', 'missing');
    expect(postChat).not.toHaveBeenCalled();
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
