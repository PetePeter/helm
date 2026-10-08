import type { ComfyUiProfileConfig } from '../../config/loader.js';

type ApiNode = { class_type: string; inputs: Record<string, unknown> };
type ApiWorkflow = Record<string, ApiNode>;

export function hasMatchingComfyImageSignature(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === 'image/png') return bytes.length >= 8
    && Buffer.from(bytes).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return mimeType === 'image/webp' && bytes.length >= 12
    && Buffer.from(bytes).toString('ascii', 0, 4) === 'RIFF'
    && Buffer.from(bytes).toString('ascii', 8, 12) === 'WEBP';
}

/** Add an uploaded source image to a cloned ComfyUI API workflow. */
export function applyComfyInputImage(
  profile: ComfyUiProfileConfig,
  sourceWorkflow: Record<string, unknown>,
  imageName: string,
): Record<string, unknown> {
  return applyComfyInputImages(profile, sourceWorkflow, [imageName]);
}

/** Attach one or more uploaded reference images to a cloned ComfyUI workflow. */
export function applyComfyInputImages(
  profile: ComfyUiProfileConfig,
  sourceWorkflow: Record<string, unknown>,
  imageNames: string[],
): Record<string, unknown> {
  const workflow = structuredClone(sourceWorkflow) as ApiWorkflow;
  if (imageNames.length === 0) return workflow;
  const refs = profile.referenceImages;
  if (refs) {
    if (imageNames.length > refs.maxImages) {
      throw new Error(`Profile ${profile.name} accepts at most ${refs.maxImages} reference images`);
    }
    const target = workflow[refs.nodeId];
    if (!target || target.class_type !== 'TextEncodeQwenImage21') {
      throw new Error(`Image profile ${profile.name} has no supported multi-reference encoder`);
    }
    const allocateId = createNodeIdAllocator(workflow);
    imageNames.forEach((imageName, index) => {
      const loadImageId = allocateId();
      workflow[loadImageId] = { class_type: 'LoadImage', inputs: { image: imageName } };
      target.inputs[`${refs.inputPrefix}${index + 1}`] = [loadImageId, 0];
    });
    return workflow;
  }
  if (imageNames.length > 1) {
    throw new Error(`Profile ${profile.name} accepts one reference image; select one image`);
  }
  const imageName = imageNames[0];
  const allocateId = createNodeIdAllocator(workflow);
  const loadImageId = allocateId();
  workflow[loadImageId] = { class_type: 'LoadImage', inputs: { image: imageName } };

  if (profile.kind === 'video') {
    const latent = Object.values(workflow).find(node =>
      node.class_type === 'Wan22ImageToVideoLatent' || Object.hasOwn(node.inputs, 'start_image'));
    if (!latent) throw new Error(`Video profile ${profile.name} has no image-to-video start frame input`);
    latent.inputs.start_image = [loadImageId, 0];
    return workflow;
  }

  const samplerId = profile.mappings.seed?.nodeId;
  const sampler = samplerId ? workflow[samplerId] : undefined;
  if (!sampler || sampler.class_type !== 'KSampler' || !isNodeLink(sampler.inputs.latent_image)) {
    throw new Error(`Image profile ${profile.name} has no supported KSampler latent input`);
  }
  const latentId = sampler.inputs.latent_image[0];
  const latentSource = workflow[latentId];
  if (!latentSource) throw new Error(`Image profile ${profile.name} has a missing latent source`);

  const decoder = Object.values(workflow).find(node =>
    node.class_type === 'VAEDecode' && isNodeLink(node.inputs.samples) && node.inputs.samples[0] === samplerId);
  const vae = decoder?.inputs.vae;
  if (!isNodeLink(vae)) throw new Error(`Image profile ${profile.name} has no VAE decode connection`);

  const pixelsId = allocateId();
  const width = latentSource.inputs.width;
  const height = latentSource.inputs.height;
  if (isPositiveDimension(width) && isPositiveDimension(height)) {
    // Profiles with a direct empty latent use the selected output dimensions.
    workflow[pixelsId] = {
      class_type: 'ImageScale',
      inputs: {
        image: [loadImageId, 0], upscale_method: 'lanczos',
        width, height, crop: 'center',
      },
    };
  } else {
    // The other shipped image graphs build a one-megapixel latent and resize
    // after decode, so keep source and sampler dimensions aligned at that size.
    workflow[pixelsId] = {
      class_type: 'ImageScaleToTotalPixels',
      inputs: { image: [loadImageId, 0], upscale_method: 'lanczos', megapixels: 1, resolution_steps: 64 },
    };
  }

  const encodeId = allocateId();
  workflow[encodeId] = {
    class_type: 'VAEEncode',
    inputs: { pixels: [pixelsId, 0], vae },
  };
  sampler.inputs.latent_image = [encodeId, 0];
  // A partial denoise keeps the attached image recognizable while allowing
  // the prompt to make visible changes. Respect a profile's lower setting.
  const denoise = sampler.inputs.denoise;
  if (typeof denoise !== 'number' || denoise >= 1) sampler.inputs.denoise = 0.65;
  return workflow;
}

function createNodeIdAllocator(workflow: ApiWorkflow): () => string {
  const used = new Set(Object.keys(workflow));
  let next = Math.max(0, ...[...used].map(id => /^\d+$/.test(id) ? Number(id) : 0)) + 1;
  return () => {
    while (used.has(String(next))) next++;
    const id = String(next++);
    used.add(id);
    return id;
  };
}

function isNodeLink(value: unknown): value is [string, number] {
  return Array.isArray(value) && typeof value[0] === 'string' && typeof value[1] === 'number';
}

function isPositiveDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
