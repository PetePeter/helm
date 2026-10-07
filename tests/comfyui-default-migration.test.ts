import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import {
  migrateComfyUiToolDefaults,
  type ComfyUiDefaultMigrationFiles,
} from '../src/config/comfyui-default-migration.js';
import { cloneDefaultComfyUiConfigForKind } from '../src/session/comfyui/comfyui-config.js';

const IMAGE_ID = '3cef90de-c638-49b5-942c-aa7c198fc294';
const VIDEO_ID = '36ccf04a-e326-4f05-b525-3d1150fa8497';
let TEST_DIR: string;
let files: ComfyUiDefaultMigrationFiles;

function readTypes(): Record<string, any> {
  return YAML.parse(fs.readFileSync(files.cliTypesFile, 'utf8'));
}

function writeTypes(types: Record<string, any>): void {
  fs.writeFileSync(files.cliTypesFile, YAML.stringify(types), 'utf8');
}

function defaultType(id: string): Record<string, any> {
  const image = id === IMAGE_ID;
  const name = image ? 'ComfyUI Image' : 'ComfyUI Video';
  return {
    id,
    name,
    displayName: name,
    comfyUi: cloneDefaultComfyUiConfigForKind(image ? 'image' : 'video'),
  };
}

beforeEach(() => {
  TEST_DIR = fs.mkdtempSync(path.join(process.cwd(), '.test-comfyui-default-migration-'));
  files = {
    cliTypesFile: path.join(TEST_DIR, 'cli-types.yaml'),
    migrationStateFile: path.join(TEST_DIR, 'config-migrations.yaml'),
  };
});

afterEach(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));

describe('ComfyUI profile migration', () => {
  it('leaves clean installs untouched and enriches tools the user already configured', () => {
    const unrelated = { existing: { id: 'existing', name: 'Existing', spawnCommand: 'existing' } };
    writeTypes(unrelated);

    expect(migrateComfyUiToolDefaults(files)).toBe(false);
    expect(readTypes()).toEqual(unrelated);
    expect(fs.existsSync(files.migrationStateFile)).toBe(false);

    const image = defaultType(IMAGE_ID);
    image.comfyUi.profiles = [structuredClone(image.comfyUi.profiles[0])];
    image.comfyUi.profiles[0].name = 'Image';
    const video = defaultType(VIDEO_ID);
    video.comfyUi.profiles = [structuredClone(video.comfyUi.profiles[0])];
    video.comfyUi.profiles[0].name = 'Video';
    writeTypes({ ...unrelated, [IMAGE_ID]: image, [VIDEO_ID]: video });

    expect(migrateComfyUiToolDefaults(files)).toBe(true);

    const types = readTypes();
    expect(types.existing.spawnCommand).toBe('existing');
    expect(types[IMAGE_ID].comfyUi.profiles.map((profile: any) => profile.name)).toEqual([
      'SDXL Turbo', 'Photoreal · LUSTIFY V8 Apex', 'FLUX.1-dev FP8',
    ]);
    expect(types[IMAGE_ID].noPromptCache).toBe(true);
    expect(types[VIDEO_ID].comfyUi.profiles.map((profile: any) => profile.name)).toEqual([
      '1080p Landscape (1920x1088)', '1080p Portrait (1088x1920)',
    ]);
    expect(types[VIDEO_ID].noPromptCache).toBe(true);
  });

  it('preserves an explicit no-prompt-cache opt-out', () => {
    const image = defaultType(IMAGE_ID);
    image.noPromptCache = false;
    writeTypes({ [IMAGE_ID]: image });

    expect(migrateComfyUiToolDefaults(files)).toBe(false);
    expect(readTypes()[IMAGE_ID].noPromptCache).toBe(false);
  });

  it('defaults no-prompt-cache for existing ComfyUI tools with custom ids and names', () => {
    const custom = defaultType(IMAGE_ID);
    delete custom.noPromptCache;
    custom.name = 'Local Flux';
    custom.displayName = 'Local Flux';
    writeTypes({ 'custom-flux': custom });

    expect(migrateComfyUiToolDefaults(files)).toBe(true);
    expect(readTypes()['custom-flux'].noPromptCache).toBe(true);
  });

  it('adds missing presets after an earlier migration while preserving user tuning', () => {
    const image = defaultType(IMAGE_ID);
    image.comfyUi.profiles = image.comfyUi.profiles.filter((profile: any) =>
      !['image-lustify-v8-apex', 'image-flux-dev-fp8'].includes(profile.id));
    image.comfyUi.profiles[0].defaults.steps = 11;
    image.comfyUi.profiles[0].workflow['7'].inputs.filename_prefix = 'MyImages';
    writeTypes({ [IMAGE_ID]: image });
    fs.writeFileSync(files.migrationStateFile, YAML.stringify({ applied: ['comfyui-tool-profiles-v2'] }));

    expect(migrateComfyUiToolDefaults(files)).toBe(true);

    const migrated = readTypes()[IMAGE_ID].comfyUi;
    expect(migrated.profiles.map((profile: any) => profile.id)).toContain('image-lustify-v8-apex');
    expect(migrated.profiles.map((profile: any) => profile.id)).toContain('image-flux-dev-fp8');
    expect(migrated.profiles.find((profile: any) => profile.id === 'image').defaults.steps).toBe(11);
    expect(migrated.profiles.find((profile: any) => profile.id === 'image').workflow['7'].inputs.filename_prefix)
      .toBe('MyImages');
    expect(YAML.parse(fs.readFileSync(files.migrationStateFile, 'utf8')).applied)
      .toContain('comfyui-tool-profiles-v4');
  });

  it('preserves custom endpoints and graphs while merging missing presets once', () => {
    const image = defaultType(IMAGE_ID);
    image.comfyUi.endpoint = 'http://192.168.1.12:8188';
    image.comfyUi.profiles = [structuredClone(image.comfyUi.profiles[0])];
    image.comfyUi.profiles[0].name = 'Image';
    image.comfyUi.profiles[0].defaults.width = 768;
    image.comfyUi.profiles[0].defaults.height = 768;
    image.comfyUi.profiles[0].defaults.steps = 9;
    image.comfyUi.profiles[0].workflow['7'].inputs.filename_prefix = 'MyImages';
    image.comfyUi.profiles.push({ ...structuredClone(image.comfyUi.profiles[0]), id: 'custom-image', name: 'My graph' });

    const video = defaultType(VIDEO_ID);
    video.comfyUi.endpoint = 'http://192.168.1.13:8188';
    video.comfyUi.profiles = [structuredClone(video.comfyUi.profiles[0])];
    video.comfyUi.profiles[0].name = 'Video';
    video.comfyUi.profiles[0].defaults.width = 832;
    video.comfyUi.profiles[0].defaults.height = 480;
    video.comfyUi.profiles[0].defaults.fps = 24;
    video.comfyUi.profiles[0].defaults.steps = 22;
    video.comfyUi.profiles[0].workflow['11'].inputs.filename_prefix = 'MyVideos';
    writeTypes({ [IMAGE_ID]: image, [VIDEO_ID]: video });

    expect(migrateComfyUiToolDefaults(files)).toBe(true);

    const migrated = readTypes();
    const imageConfig = migrated[IMAGE_ID].comfyUi;
    const imageBase = imageConfig.profiles.find((profile: any) => profile.id === 'image');
    expect(imageConfig.endpoint).toBe('http://192.168.1.12:8188');
    expect(imageBase.name).toBe('SDXL Turbo');
    expect(imageBase.defaults).toMatchObject({ width: 768, height: 768, steps: 9 });
    expect(imageBase.workflow['7'].inputs.filename_prefix).toBe('MyImages');
    expect(imageConfig.profiles.find((profile: any) => profile.id === 'custom-image').name).toBe('My graph');

    const videoConfig = migrated[VIDEO_ID].comfyUi;
    const videoBase = videoConfig.profiles.find((profile: any) => profile.id === 'video');
    expect(videoConfig.endpoint).toBe('http://192.168.1.13:8188');
    expect(videoBase.name).toBe('1080p Landscape (1920x1088)');
    expect(videoBase.defaults).toMatchObject({ width: 832, height: 480, fps: 24, steps: 22 });
    expect(videoBase.workflow['11'].inputs.filename_prefix).toBe('MyVideos');
    expect(videoConfig.profiles.map((profile: any) => profile.id)).toContain('video-1080p-portrait');

    const afterFirstRun = fs.readFileSync(files.cliTypesFile, 'utf8');
    expect(migrateComfyUiToolDefaults(files)).toBe(false);
    expect(fs.readFileSync(files.cliTypesFile, 'utf8')).toBe(afterFirstRun);
  });

  it('updates the old shipped LUSTIFY name but preserves custom models and prompts', () => {
    const image = defaultType(IMAGE_ID);
    const lustify = image.comfyUi.profiles.find((profile: any) => profile.id === 'image-lustify-v8-apex');
    lustify.workflow['1'].inputs.ckpt_name = 'lustifySDXLNSFW_apexV8.safetensors';
    lustify.workflow['2'].inputs.text = 'preserve my prompt';
    const custom = structuredClone(lustify);
    custom.id = 'custom-lustify';
    custom.name = 'My checkpoint';
    custom.workflow['1'].inputs.ckpt_name = 'my-checkpoint.safetensors';
    image.comfyUi.profiles.push(custom);
    writeTypes({ [IMAGE_ID]: image });
    fs.writeFileSync(files.migrationStateFile, YAML.stringify({ applied: ['comfyui-tool-profiles-v2'] }));

    expect(migrateComfyUiToolDefaults(files)).toBe(true);

    const profiles = readTypes()[IMAGE_ID].comfyUi.profiles;
    const migrated = profiles.find((profile: any) => profile.id === 'image-lustify-v8-apex');
    expect(migrated.workflow['1'].inputs.ckpt_name).toBe('lustifyNSFWCheckpoint_apexV8.safetensors');
    expect(migrated.workflow['2'].inputs.text).toBe('preserve my prompt');
    expect(profiles.find((profile: any) => profile.id === 'custom-lustify').workflow['1'].inputs.ckpt_name)
      .toBe('my-checkpoint.safetensors');
  });

  it('does not replace tuning with defaults when a profile lacks defaults', () => {
    const image = defaultType(IMAGE_ID);
    image.comfyUi.profiles = [structuredClone(image.comfyUi.profiles[0])];
    delete image.comfyUi.profiles[0].defaults;
    image.comfyUi.profiles[0].workflow['4'].inputs.steps = 17;
    writeTypes({ [IMAGE_ID]: image });

    expect(migrateComfyUiToolDefaults(files)).toBe(true);

    const migrated = readTypes()[IMAGE_ID].comfyUi.profiles.find((profile: any) => profile.id === 'image');
    expect(migrated.defaults).toEqual({ width: 512, height: 512 });
    expect(migrated.workflow['4'].inputs.steps).toBe(17);
  });

  it('preserves unrelated tools that occupy a ComfyUI UUID and does not create replacements', () => {
    const existing = { id: IMAGE_ID, displayName: 'Other tool', name: 'Other tool', spawnCommand: 'other-tool' };
    const video = defaultType(VIDEO_ID);
    video.comfyUi.profiles = [structuredClone(video.comfyUi.profiles[0])];
    writeTypes({ [IMAGE_ID]: existing, [VIDEO_ID]: video });

    expect(migrateComfyUiToolDefaults(files)).toBe(true);

    const types = readTypes();
    expect(types[IMAGE_ID]).toEqual(existing);
    expect(Object.values(types).filter((entry: any) => entry.displayName === 'ComfyUI Image')).toHaveLength(0);
    expect(types[VIDEO_ID].comfyUi.profiles).toHaveLength(2);
  });

  it('does not resurrect a preset the user removes after migration', () => {
    writeTypes({ [IMAGE_ID]: defaultType(IMAGE_ID) });
    expect(migrateComfyUiToolDefaults(files)).toBe(true);
    expect(YAML.parse(fs.readFileSync(files.migrationStateFile, 'utf8')).applied)
      .toContain('comfyui-tool-profiles-v4');
    const types = readTypes();
    types[IMAGE_ID].comfyUi.profiles = types[IMAGE_ID].comfyUi.profiles
      .filter((profile: any) => profile.id !== 'image-flux-dev-fp8');
    writeTypes(types);
    const userEditedConfig = fs.readFileSync(files.cliTypesFile, 'utf8');

    expect(migrateComfyUiToolDefaults(files)).toBe(false);
    expect(fs.readFileSync(files.cliTypesFile, 'utf8')).toBe(userEditedConfig);
  });
});
