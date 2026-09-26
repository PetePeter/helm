// src/voice/ffmpeg.ts

/**
 * Single place that answers "where is ffmpeg, and how do I run it".
 *
 * Two independent features need ffmpeg — audio transcription (converting an
 * arbitrary container to 16kHz mono WAV) and video frame extraction — and
 * Piper TTS needs the same child-process runner. Resolution lives here so
 * those callers cannot drift apart on which binary they find.
 *
 * Preference order is deliberate: an explicitly configured `ffmpegPath` wins,
 * because the user chose it. The copy bundled inside an OpenWhispr install is
 * only a fallback, so transcription keeps working on machines where ffmpeg was
 * never configured separately.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface FfmpegResolveOptions {
  /** Explicit path from Telegram settings (`ffmpegPath`). Takes precedence. */
  ffmpegPath?: string;
  /** OpenWhispr install root; its bundled ffmpeg-static is the fallback. */
  openWhisprPath?: string;
}

/** Resolve a usable ffmpeg executable, or null if none is available. */
export function resolveFfmpegPath(options: FfmpegResolveOptions): string | null {
  const configured = options.ffmpegPath?.trim();
  const install = options.openWhisprPath?.trim();

  const candidates = [
    configured,
    ...(install ? [
      path.join(install, 'resources', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
      path.join(install, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
    ] : []),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find(isExecutableFile) ?? null;
}

/**
 * Run a command to completion, resolving to its exit code.
 * Resolves to null when the process could not be spawned at all — callers
 * treat both that and a non-zero code as "this did not work", never as a throw.
 */
export function runProcess(command: string, args: string[]): Promise<number | null> {
  return new Promise(resolve => {
    const child = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => resolve(null));
    child.on('exit', code => resolve(code));
  });
}

function isExecutableFile(candidate: string): boolean {
  try {
    return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
