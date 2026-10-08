import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installComfyUiTools } from '../src/electron/comfyui-tool-installer.js';

describe('ComfyUI tool installer', () => {
  let testRoot: string | undefined;

  afterEach(() => {
    if (testRoot) rmSync(testRoot, { recursive: true, force: true });
    testRoot = undefined;
  });

  it('installs and updates the shipped helper and launcher under Helm local app data', () => {
    testRoot = mkdtempSync(join(tmpdir(), 'helm-comfy-tool-installer-'));
    const sourceDirectory = join(testRoot, 'app', 'tools', 'comfyui');
    const localAppData = join(testRoot, 'local-app-data');
    const destinationDirectory = join(localAppData, 'Helm', 'tools', 'comfyui');
    const files = ['Generate-ComfyMedia.ps1', 'Start-ComfyUI.ps1'];
    mkdirSync(sourceDirectory, { recursive: true });
    for (const file of files) writeFileSync(join(sourceDirectory, file), `tracked ${file}`);

    const options = {
      platform: 'win32' as NodeJS.Platform,
      isPackaged: false,
      resourcesPath: join(testRoot, 'resources'),
      appPath: join(testRoot, 'app'),
      localAppData,
    };
    expect(installComfyUiTools(options)).toEqual(files.map(file => join(destinationDirectory, file)));
    for (const file of files) {
      expect(readFileSync(join(destinationDirectory, file), 'utf8')).toBe(`tracked ${file}`);
    }

    writeFileSync(join(sourceDirectory, files[0]), 'updated tracked helper');
    expect(installComfyUiTools(options)).toEqual([join(destinationDirectory, files[0])]);
    expect(readFileSync(join(destinationDirectory, files[0]), 'utf8')).toBe('updated tracked helper');

    const packagedSource = join(options.resourcesPath, 'tools', 'comfyui');
    mkdirSync(packagedSource, { recursive: true });
    for (const file of files) writeFileSync(join(packagedSource, file), `packaged ${file}`);
    expect(installComfyUiTools({ ...options, isPackaged: true })).toEqual(files.map(file => join(destinationDirectory, file)));
    for (const file of files) {
      expect(readFileSync(join(destinationDirectory, file), 'utf8')).toBe(`packaged ${file}`);
    }
  });

  it('does not install Windows-only tools on other platforms', () => {
    expect(installComfyUiTools({
      platform: 'darwin',
      isPackaged: true,
      resourcesPath: '/unused',
      appPath: '/unused',
    })).toEqual([]);
  });
});
