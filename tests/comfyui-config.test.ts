import { describe, expect, it } from 'vitest';
import {
  applyComfyUiProfile,
  cloneDefaultComfyUiConfig,
  DEFAULT_COMFYUI_ENDPOINT,
  validateComfyUiConfig,
} from '../src/session/comfyui/comfyui-config.js';

describe('ComfyUI configuration', () => {
  it('starts with the requested native-size image and video profiles', () => {
    const config = cloneDefaultComfyUiConfig();

    expect(config.endpoint).toBe(DEFAULT_COMFYUI_ENDPOINT);
    expect(config.profiles.map(({ id, name, kind }) => [id, name, kind])).toEqual([
      ['image', '512x512', 'image'],
      ['image-1080p-portrait', '1080p Portrait', 'image'],
      ['image-1080p-landscape', '1080p Landscape', 'image'],
      ['image-4k-portrait', '4K Portrait', 'image'],
      ['image-4k-landscape', '4K Landscape', 'image'],
      ['video', '1080p Landscape (1920x1088)', 'video'],
      ['video-1080p-portrait', '1080p Portrait (1088x1920)', 'video'],
    ]);

    config.profiles[0].workflow['2'].inputs.text = 'edited locally';
    expect(cloneDefaultComfyUiConfig().profiles[0].workflow['2'].inputs.text).toBe('');
  });

  it('applies native dimensions and 30fps to the selected workflow', () => {
    const config = cloneDefaultComfyUiConfig();
    const imageSizes = config.profiles.filter(profile => profile.kind === 'image').map(profile => {
      const graph = applyComfyUiProfile(profile, 'a red kite');
      return [graph['3'].inputs.width, graph['3'].inputs.height];
    });
    const videoSettings = config.profiles.filter(profile => profile.kind === 'video').map(profile => {
      const graph = applyComfyUiProfile(profile, 'a red kite');
      return [graph['7'].inputs.width, graph['7'].inputs.height, graph['10'].inputs.fps, graph['7'].inputs.length];
    });

    expect(imageSizes).toEqual([
      [512, 512], [1080, 1920], [1920, 1080], [2160, 3840], [3840, 2160],
    ]);
    expect(videoSettings).toEqual([
      [1920, 1088, 30, 49], [1088, 1920, 30, 49],
    ]);
    for (const profile of config.profiles) {
      const graph = profile.workflow[profile.kind === 'image' ? '3' : '7'] as { inputs: Record<string, unknown> };
      expect([graph.inputs.width, graph.inputs.height]).toEqual([profile.defaults.width, profile.defaults.height]);
    }
    for (const [width, height] of videoSettings) {
      expect(width % 32).toBe(0);
      expect(height % 32).toBe(0);
    }
    for (const profile of config.profiles.filter(profile => profile.kind === 'video')) {
      expect(Object.values(profile.workflow).some(node => node.class_type === 'ImageCrop')).toBe(false);
    }
  });

  it('maps a chat prompt and profile defaults onto a cloned API workflow', () => {
    const profile = cloneDefaultComfyUiConfig().profiles[0];
    const workflow = applyComfyUiProfile(profile, 'a red kite');

    expect(workflow['2'].inputs.text).toBe('a red kite');
    expect(workflow['3'].inputs.width).toBe(512);
    expect(workflow['4'].inputs.steps).toBe(4);
    expect(profile.workflow['2'].inputs.text).toBe('');
  });

  it('randomizes the shipped zero seed while preserving a pinned seed', () => {
    const profile = cloneDefaultComfyUiConfig().profiles[0];
    expect(applyComfyUiProfile(profile, 'a red kite', 123)['4'].inputs.seed).toBe(123);
    profile.defaults!.seed = 456;
    expect(applyComfyUiProfile(profile, 'a red kite', 123)['4'].inputs.seed).toBe(456);
    delete profile.defaults;
    expect(applyComfyUiProfile(profile, 'a red kite', 789)['4'].inputs.seed).toBe(789);
  });

  it('rejects endpoints with embedded credentials', () => {
    const config = cloneDefaultComfyUiConfig();
    config.endpoint = 'http://user:secret@localhost:8188';

    expect(() => validateComfyUiConfig(config)).toThrow('without embedded credentials');
  });

  it('rejects mappings that refer to missing graph inputs', () => {
    const config = cloneDefaultComfyUiConfig();
    config.profiles[0].mappings.prompt = { nodeId: '2', input: 'missing' };

    expect(() => validateComfyUiConfig(config)).toThrow('maps prompt to a missing node input');
  });
});
