import type { ComfyUiProfileConfig, ComfyUiToolConfig } from '../../config/loader.js';

export const DEFAULT_COMFYUI_ENDPOINT = 'http://127.0.0.1:8188';
/** The launcher Helm's media helper installs; the shell expands the variable. */
export const DEFAULT_COMFYUI_START_COMMAND = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\\Helm\\tools\\comfyui\\Start-ComfyUI.ps1"';

export const COMFYUI_IMAGE_SIZE_OPTIONS = [
  { id: 'vga-landscape', name: 'VGA Landscape', width: 640, height: 480 },
  { id: 'vga-portrait', name: 'VGA Portrait', width: 480, height: 640 },
  { id: 'fhd-landscape', name: 'FHD Landscape', width: 1920, height: 1080 },
  { id: 'fhd-portrait', name: 'FHD Portrait', width: 1080, height: 1920 },
  { id: 'qhd-landscape', name: 'QHD Landscape', width: 2560, height: 1440 },
  { id: 'qhd-portrait', name: 'QHD Portrait', width: 1440, height: 2560 },
  { id: '4k-landscape', name: '4K UHD Landscape', width: 3840, height: 2160 },
  { id: '4k-portrait', name: '4K UHD Portrait', width: 2160, height: 3840 },
] as const;

export type ComfyUiImageSizeId = typeof COMFYUI_IMAGE_SIZE_OPTIONS[number]['id'];
export type ComfyUiChatProfile = { id: string; name: string; kind: 'image' | 'video'; supportsImageSize: boolean };

const LEGACY_IMAGE_SIZE_PROFILE_IDS = new Set([
  'image-1080p-portrait', 'image-1080p-landscape', 'image-4k-portrait', 'image-4k-landscape',
]);

export function comfyUiChatProfiles(config: ComfyUiToolConfig): ComfyUiChatProfile[] {
  return config.profiles
    .filter(profile => !LEGACY_IMAGE_SIZE_PROFILE_IDS.has(profile.id))
    .map(profile => ({
      id: profile.id,
      name: profile.name,
      kind: profile.kind,
      supportsImageSize: profile.kind === 'image' && Boolean(profile.mappings.width && profile.mappings.height),
    }));
}

export function comfyUiImageSizes(config: ComfyUiToolConfig): typeof COMFYUI_IMAGE_SIZE_OPTIONS[number][] {
  return config.profiles.some(profile => profile.kind === 'image' && profile.mappings.width && profile.mappings.height)
    ? [...COMFYUI_IMAGE_SIZE_OPTIONS]
    : [];
}

const IMAGE_WORKFLOW: ComfyUiProfileConfig['workflow'] = {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_turbo_1.0_fp16.safetensors' } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
  '3': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  '4': { class_type: 'KSampler', inputs: { seed: 0, steps: 4, cfg: 1, sampler_name: 'euler_ancestral', scheduler: 'sgm_uniform', denoise: 1, model: ['1', 0], positive: ['2', 0], negative: ['5', 0], latent_image: ['3', 0] } },
  '5': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
  '6': { class_type: 'VAEDecode', inputs: { samples: ['4', 0], vae: ['1', 2] } },
  '7': { class_type: 'SaveImage', inputs: { filename_prefix: 'Helm', images: ['6', 0] } },
};

interface ImageProfileOptions {
  checkpoint?: string;
  steps?: number;
  cfg?: number;
  samplerName?: string;
  scheduler?: string;
}

const IMAGE_MAPPINGS: ComfyUiProfileConfig['mappings'] = {
  prompt: { nodeId: '2', input: 'text' },
  negativePrompt: { nodeId: '5', input: 'text' },
  width: { nodeId: '3', input: 'width' },
  height: { nodeId: '3', input: 'height' },
  steps: { nodeId: '4', input: 'steps' },
  cfg: { nodeId: '4', input: 'cfg' },
  seed: { nodeId: '4', input: 'seed' },
};

function imageProfile(
  id: string,
  name: string,
  width: number,
  height: number,
  options: ImageProfileOptions = {},
): ComfyUiProfileConfig {
  const workflow = structuredClone(IMAGE_WORKFLOW);
  const checkpoint = workflow['1'] as { inputs: Record<string, unknown> };
  const latent = workflow['3'] as { inputs: Record<string, unknown> };
  const sampler = workflow['4'] as { inputs: Record<string, unknown> };
  const steps = options.steps ?? 4;
  const cfg = options.cfg ?? 1;
  checkpoint.inputs.ckpt_name = options.checkpoint ?? 'sd_xl_turbo_1.0_fp16.safetensors';
  latent.inputs.width = width;
  latent.inputs.height = height;
  sampler.inputs.steps = steps;
  sampler.inputs.cfg = cfg;
  if (options.samplerName) sampler.inputs.sampler_name = options.samplerName;
  if (options.scheduler) sampler.inputs.scheduler = options.scheduler;
  return {
    id,
    name,
    kind: 'image',
    workflow,
    mappings: structuredClone(IMAGE_MAPPINGS),
    defaults: { negativePrompt: '', width, height, steps, cfg, seed: 0 },
    outputNodeIds: ['7'],
  };
}

const VIDEO_NEGATIVE_PROMPT = '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走';

const VIDEO_WORKFLOW: ComfyUiProfileConfig['workflow'] = {
  '1': { class_type: 'UNETLoader', inputs: { unet_name: 'wan2.2_ti2v_5B_fp16.safetensors', weight_dtype: 'default' } },
  '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', type: 'wan', device: 'default' } },
  '3': { class_type: 'VAELoader', inputs: { vae_name: 'wan2.2_vae.safetensors' } },
  '4': { class_type: 'ModelSamplingSD3', inputs: { model: ['1', 0], shift: 8 } },
  '5': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['2', 0] } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: VIDEO_NEGATIVE_PROMPT, clip: ['2', 0] } },
  '7': { class_type: 'Wan22ImageToVideoLatent', inputs: { width: 1920, height: 1088, length: 49, batch_size: 1, vae: ['3', 0], positive: ['5', 0], negative: ['6', 0] } },
  '8': { class_type: 'KSampler', inputs: { seed: 0, steps: 20, cfg: 5, sampler_name: 'uni_pc', scheduler: 'simple', denoise: 1, model: ['4', 0], positive: ['5', 0], negative: ['6', 0], latent_image: ['7', 0] } },
  '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
  '10': { class_type: 'CreateVideo', inputs: { images: ['9', 0], fps: 30 } },
  '11': { class_type: 'SaveVideo', inputs: { video: ['10', 0], filename_prefix: 'HelmVideo', format: 'auto', 'format.codec': 'auto' } },
};

const VIDEO_MAPPINGS: ComfyUiProfileConfig['mappings'] = {
  prompt: { nodeId: '5', input: 'text' },
  negativePrompt: { nodeId: '6', input: 'text' },
  width: { nodeId: '7', input: 'width' },
  height: { nodeId: '7', input: 'height' },
  length: { nodeId: '7', input: 'length' },
  steps: { nodeId: '8', input: 'steps' },
  cfg: { nodeId: '8', input: 'cfg' },
  seed: { nodeId: '8', input: 'seed' },
  fps: { nodeId: '10', input: 'fps' },
};

function videoProfile(id: string, name: string, width: number, height: number): ComfyUiProfileConfig {
  const workflow = structuredClone(VIDEO_WORKFLOW);
  const latent = workflow['7'] as { inputs: Record<string, unknown> };
  latent.inputs.width = width;
  latent.inputs.height = height;
  return {
    id,
    name,
    kind: 'video',
    workflow,
    mappings: structuredClone(VIDEO_MAPPINGS),
    defaults: { negativePrompt: VIDEO_NEGATIVE_PROMPT, width, height, length: 49, steps: 20, cfg: 5, seed: 0, fps: 30 },
    outputNodeIds: ['11'],
  };
}

export const DEFAULT_COMFYUI_CONFIG: ComfyUiToolConfig = {
  endpoint: DEFAULT_COMFYUI_ENDPOINT,
  startCommand: DEFAULT_COMFYUI_START_COMMAND,
  profiles: [
    imageProfile('image', 'SDXL Turbo', 512, 512),
    imageProfile('image-lustify-v8-apex', 'Photoreal · LUSTIFY V8 Apex', 1536, 1536, {
      checkpoint: 'lustifyNSFWCheckpoint_apexV8.safetensors',
      steps: 30,
      cfg: 3.5,
      samplerName: 'dpmpp_2m_sde',
      scheduler: 'karras',
    }),
    videoProfile('video', '1080p Landscape (1920x1088)', 1920, 1088),
    videoProfile('video-1080p-portrait', '1080p Portrait (1088x1920)', 1088, 1920),
  ],
};

export function cloneDefaultComfyUiConfig(): ComfyUiToolConfig {
  return structuredClone(DEFAULT_COMFYUI_CONFIG);
}

export function cloneDefaultComfyUiConfigForKind(kind: 'image' | 'video'): ComfyUiToolConfig {
  const config = cloneDefaultComfyUiConfig();
  return { ...config, profiles: config.profiles.filter(profile => profile.kind === kind) };
}

export function validateComfyUiConfig(value: unknown): ComfyUiToolConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ComfyUI configuration is required');
  const config = value as Partial<ComfyUiToolConfig>;
  const endpoint = typeof config.endpoint === 'string' ? config.endpoint.trim() : '';
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error('ComfyUI endpoint must be an HTTP or HTTPS URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('ComfyUI endpoint must be an HTTP or HTTPS URL without embedded credentials');
  }
  if (config.startCommand !== undefined && typeof config.startCommand !== 'string') throw new Error('ComfyUI start command must be text');
  const startCommand = config.startCommand?.trim();
  if (!Array.isArray(config.profiles) || config.profiles.length < 1) throw new Error('Add at least one ComfyUI profile');
  const ids = new Set<string>();
  const profiles = config.profiles.map((candidate): ComfyUiProfileConfig => {
    if (!candidate || typeof candidate !== 'object') throw new Error('Each ComfyUI profile must be an object');
    const profile = candidate as ComfyUiProfileConfig;
    if (typeof profile.id !== 'string' || !profile.id.trim() || ids.has(profile.id.trim())) throw new Error('ComfyUI profile ids must be unique and non-empty');
    const id = profile.id.trim();
    ids.add(id);
    if (typeof profile.name !== 'string' || !profile.name.trim() || !['image', 'video'].includes(profile.kind)) throw new Error(`Invalid ComfyUI profile: ${id}`);
    if (!profile.workflow || typeof profile.workflow !== 'object' || Array.isArray(profile.workflow)) throw new Error(`Profile ${profile.name} has no API workflow object`);
    if (!profile.mappings || typeof profile.mappings !== 'object' || Array.isArray(profile.mappings)) throw new Error(`Profile ${profile.name} has no input mappings`);
    const nodes = profile.workflow as Record<string, { class_type?: unknown; inputs?: unknown }>;
    for (const [nodeId, node] of Object.entries(nodes)) {
      if (!node || typeof node.class_type !== 'string' || !node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs)) {
        throw new Error(`Profile ${profile.name} has an invalid node ${nodeId}`);
      }
    }
    if (!Array.isArray(profile.outputNodeIds) || profile.outputNodeIds.length === 0 || profile.outputNodeIds.some(id => !nodes[id])) {
      throw new Error(`Profile ${profile.name} must map at least one existing output node`);
    }
    for (const [field, mapping] of Object.entries(profile.mappings ?? {})) {
      if (!mapping || !nodes[mapping.nodeId] || !(mapping.input in (nodes[mapping.nodeId].inputs as object))) {
        throw new Error(`Profile ${profile.name} maps ${field} to a missing node input`);
      }
    }
    return structuredClone({ ...profile, id, name: profile.name.trim() });
  });
  return { endpoint: url.toString().replace(/\/$/, ''), ...(startCommand ? { startCommand } : {}), profiles };
}

export function applyComfyUiProfile(
  profile: ComfyUiProfileConfig,
  prompt: string,
  randomSeed?: number,
  imageSizeId?: string,
): Record<string, unknown> {
  const workflow = structuredClone(profile.workflow) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  for (const [field, binding] of Object.entries(profile.mappings)) {
    const value = field === 'prompt' ? prompt : profile.defaults?.[field as keyof NonNullable<ComfyUiProfileConfig['defaults']>];
    if (value !== undefined) workflow[binding!.nodeId].inputs[binding!.input] = value;
  }
  if (imageSizeId !== undefined) {
    const size = COMFYUI_IMAGE_SIZE_OPTIONS.find(option => option.id === imageSizeId);
    if (!size) throw new Error(`Unknown ComfyUI image size: ${imageSizeId}`);
    const width = profile.mappings.width;
    const height = profile.mappings.height;
    if (profile.kind !== 'image' || !width || !height) {
      throw new Error(`Profile ${profile.name} does not support image size selection`);
    }
    workflow[width.nodeId].inputs[width.input] = size.width;
    workflow[height.nodeId].inputs[height.input] = size.height;
  }
  // Zero is the shipped "random per generation" default; a nonzero configured
  // seed remains pinned so users can reproduce a result.
  const seed = profile.defaults?.seed;
  const seedBinding = profile.mappings.seed;
  const workflowSeed = seedBinding ? workflow[seedBinding.nodeId].inputs[seedBinding.input] : undefined;
  if (seedBinding && (seed === 0 || (seed === undefined && workflowSeed === 0))) {
    workflow[seedBinding.nodeId].inputs[seedBinding.input] = randomSeed ?? globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
  }
  return workflow;
}
