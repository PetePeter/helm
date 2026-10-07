import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import {
  migrateComfyUiToolDefaults,
  type ComfyUiDefaultMigrationFiles,
} from '../src/config/comfyui-default-migration.js';

const IMAGE_ID = '3cef90de-c638-49b5-942c-aa7c198fc294';
const VIDEO_ID = '36ccf04a-e326-4f05-b525-3d1150fa8497';
const SHIPPED_TYPES_FILE = path.join(process.cwd(), 'src', 'config', 'cli-types.yaml');
let TEST_DIR: string;
let files: ComfyUiDefaultMigrationFiles;

function readTypes(): Record<string, any> {
  return YAML.parse(fs.readFileSync(files.cliTypesFile, 'utf8'));
}

function writeTypes(types: Record<string, any>): void {
  fs.writeFileSync(files.cliTypesFile, YAML.stringify(types), 'utf8');
}

function shippedType(id: string): Record<string, any> {
  return YAML.parse(fs.readFileSync(SHIPPED_TYPES_FILE, 'utf8'))[id];
}

beforeEach(() => {
  TEST_DIR = fs.mkdtempSync(path.join(process.cwd(), '.test-comfyui-default-migration-'));
  files = {
    cliTypesFile: path.join(TEST_DIR, 'cli-types.yaml'),
    migrationStateFile: path.join(TEST_DIR, 'config-migrations.yaml'),
    shippedCliTypesFile: SHIPPED_TYPES_FILE,
  };
});

afterEach(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));

describe('ComfyUI shipped-default migration', () => {
  it('adds the two tools and profile sets to an existing config', () => {
    writeTypes({ existing: { id: 'existing', name: 'Existing', displayName: 'Existing', spawnCommand: 'existing' } });

    expect(migrateComfyUiToolDefaults(files)).toBe(true);

    const types = readTypes();
    expect(types.existing.spawnCommand).toBe('existing');
    expect(types[IMAGE_ID].displayName).toBe('ComfyUI Image');
    expect(types[IMAGE_ID].comfyUi.profiles.map((profile: any) => profile.name)).toEqual([
      '512x512', '1080p Portrait', '1080p Landscape', '4K Portrait', '4K Landscape',
    ]);
    expect(types[VIDEO_ID].comfyUi.profiles.map((profile: any) => profile.name)).toEqual([
      '1080p Landscape (1920x1088)', '1080p Portrait (1088x1920)',
    ]);
  });

  it('preserves custom endpoints and graphs while merging the new presets once', () => {
    const image = shippedType(IMAGE_ID);
    image.comfyUi.endpoint = 'http://192.168.1.12:8188';
    image.comfyUi.profiles = [structuredClone(image.comfyUi.profiles[0])];
    image.comfyUi.profiles[0].name = 'Image';
    image.comfyUi.profiles[0].defaults.steps = 9;
    image.comfyUi.profiles[0].workflow['7'].inputs.filename_prefix = 'MyImages';
    image.comfyUi.profiles.push({
      ...structuredClone(image.comfyUi.profiles[0]),
      id: 'custom-image',
      name: 'My graph',
    });

    const video = shippedType(VIDEO_ID);
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
    expect(imageBase.name).toBe('512x512');
    expect(imageBase.defaults).toMatchObject({ width: 512, height: 512, steps: 9 });
    expect(imageBase.workflow['7'].inputs.filename_prefix).toBe('MyImages');
    expect(imageConfig.profiles.find((profile: any) => profile.id === 'custom-image').name).toBe('My graph');

    const videoConfig = migrated[VIDEO_ID].comfyUi;
    const videoBase = videoConfig.profiles.find((profile: any) => profile.id === 'video');
    expect(videoConfig.endpoint).toBe('http://192.168.1.13:8188');
    expect(videoBase.name).toBe('1080p Landscape (1920x1088)');
    expect(videoBase.defaults).toMatchObject({ width: 1920, height: 1088, fps: 30, steps: 22 });
    expect(videoBase.workflow['11'].inputs.filename_prefix).toBe('MyVideos');
    expect(videoConfig.profiles.map((profile: any) => profile.id)).toContain('video-1080p-portrait');

    const afterFirstRun = fs.readFileSync(files.cliTypesFile, 'utf8');
    expect(migrateComfyUiToolDefaults(files)).toBe(false);
    expect(fs.readFileSync(files.cliTypesFile, 'utf8')).toBe(afterFirstRun);
  });

  it('does not replace tuning with shipped defaults when an old profile lacks defaults', () => {
    const image = shippedType(IMAGE_ID);
    image.comfyUi.profiles = [structuredClone(image.comfyUi.profiles[0])];
    delete image.comfyUi.profiles[0].defaults;
    image.comfyUi.profiles[0].workflow['4'].inputs.steps = 17;
    writeTypes({ [IMAGE_ID]: image });

    expect(migrateComfyUiToolDefaults(files)).toBe(true);

    const migrated = readTypes()[IMAGE_ID].comfyUi.profiles.find((profile: any) => profile.id === 'image');
    expect(migrated.defaults).toEqual({ width: 512, height: 512 });
    expect(migrated.workflow['4'].inputs.steps).toBe(17);
  });

  it('preserves an unrelated tool that already owns a shipped ComfyUI id', () => {
    const existing = { id: IMAGE_ID, displayName: 'Other tool', name: 'Other tool', spawnCommand: 'other-tool' };
    writeTypes({ [IMAGE_ID]: existing });

    expect(migrateComfyUiToolDefaults(files)).toBe(true);

    const types = readTypes();
    expect(types[IMAGE_ID]).toEqual(existing);
    const imageTool = Object.values(types).find((entry: any) => entry.displayName === 'ComfyUI Image') as any;
    expect(imageTool.comfyUi.profiles.map((profile: any) => profile.kind)).toEqual(['image', 'image', 'image', 'image', 'image']);
  });

  it('does not resurrect a profile the user removes after migration', () => {
    expect(migrateComfyUiToolDefaults(files)).toBe(true);
    const types = readTypes();
    types[IMAGE_ID].comfyUi.profiles = types[IMAGE_ID].comfyUi.profiles
      .filter((profile: any) => profile.id !== 'image-4k-landscape');
    writeTypes(types);
    const userEditedConfig = fs.readFileSync(files.cliTypesFile, 'utf8');

    expect(migrateComfyUiToolDefaults(files)).toBe(false);
    expect(fs.readFileSync(files.cliTypesFile, 'utf8')).toBe(userEditedConfig);
  });
});
