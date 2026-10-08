import { describe, expect, it } from 'vitest';
import { applyComfyInputImage, applyComfyInputImages } from '../src/session/comfyui/comfyui-image-input.js';
import { applyComfyUiProfile, cloneDefaultComfyUiConfig } from '../src/session/comfyui/comfyui-config.js';

describe('ComfyUI image inputs', () => {
  it('adds img2img nodes to every configured image profile without mutating its base workflow', () => {
    const profiles = cloneDefaultComfyUiConfig().profiles.filter(profile => profile.kind === 'image');

    for (const profile of profiles) {
      const base = applyComfyUiProfile(profile, 'update the image', undefined, 'fhd-landscape');
      const graph = applyComfyInputImage(profile, base, 'helm-source.png') as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
      if (profile.referenceImages) {
        const encoder = graph[profile.referenceImages.nodeId];
        const link = encoder.inputs[`${profile.referenceImages.inputPrefix}1`] as [string, number];
        expect(encoder.class_type).toBe('TextEncodeQwenImage21');
        expect(graph[link[0]]).toMatchObject({ class_type: 'LoadImage', inputs: { image: 'helm-source.png' } });
        continue;
      }
      const samplerId = profile.mappings.seed!.nodeId;
      const sampler = graph[samplerId];
      const encodeLink = sampler.inputs.latent_image as [string, number];
      const encoder = graph[encodeLink[0]];
      const pixelLink = encoder.inputs.pixels as [string, number];
      const pixels = graph[pixelLink[0]];
      const loadLink = pixels.inputs.image as [string, number];

      expect(sampler.class_type).toBe('KSampler');
      expect(sampler.inputs.denoise).toBe(0.65);
      expect(encoder.class_type).toBe('VAEEncode');
      expect(graph[loadLink[0]]).toMatchObject({ class_type: 'LoadImage', inputs: { image: 'helm-source.png' } });
      expect(pixels.class_type).toMatch(/^ImageScale/);
      expect(encoder.inputs.vae).toEqual(
        Object.values(graph).find(node => node.class_type === 'VAEDecode' && (node.inputs.samples as [string, number])[0] === samplerId)!.inputs.vae,
      );
      expect(profile.workflow).toEqual(cloneDefaultComfyUiConfig().profiles.find(candidate => candidate.id === profile.id)!.workflow);
    }
  });

  it('connects several selected references to the Qwen image encoder', () => {
    const profile = cloneDefaultComfyUiConfig().profiles.find(profile => profile.referenceImages)!;
    const graph = applyComfyInputImages(profile, applyComfyUiProfile(profile, 'combine them'), ['first.png', 'second.png']) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    for (const [index, name] of ['first.png', 'second.png'].entries()) {
      const link = graph[profile.referenceImages!.nodeId].inputs[`${profile.referenceImages!.inputPrefix}${index + 1}`] as [string, number];
      expect(graph[link[0]]).toMatchObject({ class_type: 'LoadImage', inputs: { image: name } });
    }
  });

  it('adds the uploaded image as the start frame for each configured video profile', () => {
    const profiles = cloneDefaultComfyUiConfig().profiles.filter(profile => profile.kind === 'video');
    for (const profile of profiles) {
      const graph = applyComfyInputImage(profile, applyComfyUiProfile(profile, 'animate the image'), 'helm-source.webp') as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
      const latent = Object.values(graph).find(node => node.class_type === 'Wan22ImageToVideoLatent')!;
      const link = latent.inputs.start_image as [string, number];
      expect(graph[link[0]]).toMatchObject({ class_type: 'LoadImage', inputs: { image: 'helm-source.webp' } });
    }
  });
});
