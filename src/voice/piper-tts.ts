import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runProcess } from './ffmpeg.js';

/**
 * Build the piper CLI args: read text from stdin, write a WAV to the given path.
 * Kept pure so it can be asserted without spawning a process.
 */
export function buildPiperArgs(voiceModelPath: string, outWavPath: string): string[] {
  return ['-m', voiceModelPath, '-f', outWavPath];
}

/**
 * Build the ffmpeg args to transcode a WAV into OGG/Opus at 96kbps —
 * the format Telegram plays back natively as a voice message.
 */
export function buildFfmpegArgs(inWavPath: string, outOggPath: string): string[] {
  return ['-y', '-i', inWavPath, '-c:a', 'libopus', '-b:a', '96k', outOggPath];
}

export interface PiperTtsOptions {
  piperPath?: string;
  piperVoicePath?: string;
  ffmpegPath?: string;
  tmpDir: string;
}

/**
 * Helm-side text-to-speech: piper synthesizes a WAV, ffmpeg transcodes it to
 * OGG/Opus (Telegram voice notes; Chromium plays it natively for desktop voice). The calling LLM never touches these binaries — it
 * only supplies text.
 */
export class PiperTts {
  constructor(private readonly options: PiperTtsOptions) {}

  async synthesize(text: string): Promise<{ oggPath: string }> {
    const { piperPath, piperVoicePath, ffmpegPath, tmpDir } = this.options;
    if (!piperVoicePath || piperVoicePath.trim() === '') {
      throw new Error('piper voice model path is not configured');
    }
    if (!piperPath || piperPath.trim() === '') {
      throw new Error('piper executable path is not configured');
    }
    if (!ffmpegPath || ffmpegPath.trim() === '') {
      throw new Error('ffmpeg executable path is not configured');
    }

    await fs.promises.mkdir(tmpDir, { recursive: true });
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const wavPath = path.join(tmpDir, `voice-${stamp}.wav`);
    const oggPath = path.join(tmpDir, `voice-${stamp}.ogg`);

    let succeeded = false;
    try {
      await runPiper(piperPath, buildPiperArgs(piperVoicePath, wavPath), text);
      if (!fs.existsSync(wavPath)) {
        throw new Error('piper did not produce a WAV file');
      }
      const ffmpegCode = await runProcess(ffmpegPath, buildFfmpegArgs(wavPath, oggPath));
      if (ffmpegCode !== 0 || !fs.existsSync(oggPath)) {
        throw new Error(`ffmpeg conversion failed (exit ${ffmpegCode})`);
      }
      succeeded = true;
      return { oggPath };
    } finally {
      await fs.promises.unlink(wavPath).catch(() => {});
      // On any failure, ffmpeg may have left a partial/orphan OGG — the caller
      // never receives the path when synthesize() throws, so clean it up here.
      if (!succeeded) {
        await fs.promises.unlink(oggPath).catch(() => {});
      }
    }
  }
}

/** Spawn piper, write text to stdin, resolve on a clean exit. */
function runPiper(command: string, args: string[], text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    child.on('error', (err) => settle(() => reject(new Error(`piper failed to start: ${err.message}`))));
    child.on('exit', (code) => settle(() => {
      if (code === 0) resolve();
      else reject(new Error(`piper exited with code ${code}`));
    }));
    // If piper dies early it closes stdin; writing then emits EPIPE on the
    // stream. Catch it here so it settles cleanly instead of escaping unhandled.
    child.stdin.on('error', (err) => settle(() => reject(new Error(`piper stdin error: ${err.message}`))));
    child.stdin.write(text, (err) => {
      if (err) return;
      child.stdin.end();
    });
  });
}
