import { describe, expect, it } from 'vitest';
import {
  applyComfyUiProfile,
  comfyUiChatProfiles,
  COMFYUI_IMAGE_SIZE_OPTIONS,
  cloneDefaultComfyUiConfig,
  DEFAULT_COMFYUI_ENDPOINT,
  validateComfyUiConfig,
} from '../src/session/comfyui/comfyui-config.js';

describe('ComfyUI configuration', () => {
  it('starts with distinct image workflows and schema-compatible video profiles', () => {
    const config = cloneDefaultComfyUiConfig();

    expect(config.endpoint).toBe(DEFAULT_COMFYUI_ENDPOINT);
    expect(config.profiles.map(({ id, name, kind }) => [id, name, kind])).toEqual([
      ['image', 'SDXL Turbo', 'image'],
      ['image-lustify-v8-apex', 'Photoreal · LUSTIFY V8 Apex', 'image'],
      ['image-z-image-turbo', 'Graphics · Z-Image Turbo', 'image'],
      ['image-qwen-image-2-1', 'Detail · Qwen-Image 2.1 (slow)', 'image'],
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
      const width = profile.mappings.width!;
      const height = profile.mappings.height!;
      return [
        graph[width.nodeId].inputs[width.input],
        graph[height.nodeId].inputs[height.input],
      ];
    });
    const videoSettings = config.profiles.filter(profile => profile.kind === 'video').map(profile => {
      const graph = applyComfyUiProfile(profile, 'a red kite');
      return [graph['7'].inputs.width, graph['7'].inputs.height, graph['10'].inputs.fps, graph['7'].inputs.length];
    });

    for (const profile of config.profiles.filter(profile => profile.kind === 'video')) {
      const graph = applyComfyUiProfile(profile, 'a red kite');
      expect(graph['7'].inputs).not.toHaveProperty('positive');
      expect(graph['7'].inputs).not.toHaveProperty('negative');
      expect(graph['8'].inputs).toMatchObject({ positive: ['5', 0], negative: ['6', 0] });
    }

    expect(imageSizes).toEqual([[512, 512], [1024, 1024], [1024, 1024], [1024, 1024]]);
    expect(videoSettings).toEqual([
      [1920, 1088, 30, 49], [1088, 1920, 30, 49],
    ]);
    for (const profile of config.profiles) {
      const width = profile.mappings.width!;
      const height = profile.mappings.height!;
      expect([
        profile.workflow[width.nodeId].inputs[width.input],
        profile.workflow[height.nodeId].inputs[height.input],
      ]).toEqual([profile.defaults.width, profile.defaults.height]);
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

  it('applies every chat image size independently to the selected image workflow', () => {
    const config = cloneDefaultComfyUiConfig();
    const profiles = config.profiles.filter(profile => profile.kind === 'image');
    const expected = [
      [640, 480], [480, 640], [1920, 1080], [1080, 1920],
      [2560, 1440], [1440, 2560], [3840, 2160], [2160, 3840],
    ];

    expect(COMFYUI_IMAGE_SIZE_OPTIONS.map(({ width, height }) => [width, height])).toEqual(expected);
    for (const profile of profiles) {
      for (const [index, size] of COMFYUI_IMAGE_SIZE_OPTIONS.entries()) {
        const graph = applyComfyUiProfile(profile, 'prompt', 7, size.id);
        const width = profile.mappings.width!;
        const height = profile.mappings.height!;
        expect([graph[width.nodeId].inputs[width.input], graph[height.nodeId].inputs[height.input]])
          .toEqual(expected[index]);
      }
    }
  });

  it('keeps legacy resolution-only entries out of the model picker while retaining real models', () => {
    const config = cloneDefaultComfyUiConfig();
    const base = config.profiles[0];
    config.profiles.push(
      { ...structuredClone(base), id: 'image-1080p-portrait', name: '1080p Portrait' },
      { ...structuredClone(base), id: 'image-1080p-landscape', name: '1080p Landscape' },
      { ...structuredClone(base), id: 'image-4k-portrait', name: '4K Portrait' },
      { ...structuredClone(base), id: 'image-4k-landscape', name: '4K Landscape' },
    );

    expect(comfyUiChatProfiles(config).map(profile => profile.id)).toEqual([
      'image', 'image-lustify-v8-apex', 'image-z-image-turbo', 'image-qwen-image-2-1', 'video', 'video-1080p-portrait',
    ]);
  });

  it('rejects size overrides on video or workflows without both dimension mappings', () => {
    const config = cloneDefaultComfyUiConfig();
    const video = config.profiles.find(profile => profile.kind === 'video')!;
    expect(() => applyComfyUiProfile(video, 'prompt', 7, 'fhd-landscape'))
      .toThrow('does not support image size selection');

    const image = config.profiles.find(profile => profile.id === 'image')!;
    delete image.mappings.height;
    expect(() => applyComfyUiProfile(image, 'prompt', 7, 'fhd-landscape'))
      .toThrow('does not support image size selection');
  });

  it('ships the photoreal LUSTIFY image workflow with its model-specific settings', () => {
    const profiles = cloneDefaultComfyUiConfig().profiles;
    const lustify = profiles.find(profile => profile.id === 'image-lustify-v8-apex')!;
    const lustifyGraph = applyComfyUiProfile(lustify, 'a realistic portrait');
    expect(lustifyGraph['1'].inputs.ckpt_name).toBe('lustifyNSFWCheckpoint_apexV8.safetensors');
    expect(lustifyGraph['4'].inputs).toMatchObject({ steps: 30, cfg: 3.5, sampler_name: 'dpmpp_2m_sde', scheduler: 'karras' });
    expect(lustifyGraph['5'].inputs.text).not.toBe('');

    // The picked size reaches the size probe, never the first-pass latent:
    // SDXL warps anatomy when sampled above about one megapixel.
    const fhd = applyComfyUiProfile(lustify, 'a realistic portrait', 7, 'fhd-landscape');
    expect(fhd['8'].inputs).toMatchObject({ width: 1920, height: 1080 });
    expect(fhd['3'].inputs).toMatchObject({ width: ['10', 0], height: ['10', 1] });
    expect(fhd['9'].inputs.megapixels).toBe(1);
    // The repaint pass works on the resized image and its result is what gets saved.
    expect(fhd['13'].inputs).toMatchObject({ cfg: 3.5, sampler_name: 'dpmpp_2m_sde', scheduler: 'karras', latent_image: ['12', 0] });
    expect(fhd['13'].inputs.denoise).toBeLessThan(1);
    // Above the repaint cap the picked size is reached by a plain resize of the repainted image.
    expect(String(fhd['16'].inputs.expression)).toContain('min(');
    expect(fhd['17'].inputs).toMatchObject({ image: ['14', 0], width: ['15', 0], height: ['15', 1] });
    expect(fhd['7'].inputs.images).toEqual(['17', 0]);

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
