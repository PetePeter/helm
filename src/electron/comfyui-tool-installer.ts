import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const COMFYUI_TOOL_FILES = ['Generate-ComfyMedia.ps1', 'Start-ComfyUI.ps1'] as const;

export interface ComfyUiToolInstallOptions {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  localAppData?: string;
}

/** Install Helm's shipped ComfyUI scripts where the default start command expects them. */
export function installComfyUiTools(options: ComfyUiToolInstallOptions): string[] {
  if (options.platform !== 'win32') return [];
  if (!options.localAppData) throw new Error('LOCALAPPDATA is unavailable; ComfyUI tools cannot be installed.');

  const sourceDirectory = options.isPackaged
    ? join(options.resourcesPath, 'tools', 'comfyui')
    : join(options.appPath, 'tools', 'comfyui');
  const destinationDirectory = join(options.localAppData, 'Helm', 'tools', 'comfyui');
  const updated: string[] = [];

  for (const filename of COMFYUI_TOOL_FILES) {
    const sourcePath = join(sourceDirectory, filename);
    if (!existsSync(sourcePath)) throw new Error(`Bundled ComfyUI tool is missing: ${sourcePath}`);
  }

  mkdirSync(destinationDirectory, { recursive: true });
  for (const filename of COMFYUI_TOOL_FILES) {
    const sourcePath = join(sourceDirectory, filename);
    const destinationPath = join(destinationDirectory, filename);
    if (existsSync(destinationPath) && readFileSync(sourcePath).equals(readFileSync(destinationPath))) continue;
    copyFileSync(sourcePath, destinationPath);
    updated.push(destinationPath);
  }
  return updated;
}
