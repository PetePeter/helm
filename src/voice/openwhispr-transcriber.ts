import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { resolveFfmpegPath, runProcess } from './ffmpeg.js';
import { logger } from '../utils/logger.js';

export interface AudioTranscriptionResult {
  text: string;
  transcriptPath: string;
}

export interface AudioTranscriber {
  transcribe(filePath: string, mimeType?: string): Promise<AudioTranscriptionResult | null>;
}

export interface OpenWhisprTranscriberOptions {
  openWhisprPath?: string;
  modelPath?: string;
  /** Explicit ffmpeg from settings; falls back to the OpenWhispr bundle. */
  ffmpegPath?: string;
}

export class OpenWhisprTranscriber implements AudioTranscriber {
  constructor(private readonly options: OpenWhisprTranscriberOptions) {}

  async transcribe(filePath: string, mimeType?: string): Promise<AudioTranscriptionResult | null> {
    const installPath = this.options.openWhisprPath?.trim();
    if (!installPath) return null;

    const serverExe = resolveWhisperServerPath(installPath);
    const modelPath = resolveModelPath(this.options.modelPath);
    if (!serverExe || !modelPath) {
      logger.warn('[OpenWhispr] Cannot transcribe audio: OpenWhispr server or model not found');
      return null;
    }

    const wavPath = await this.convertToWavIfNeeded(filePath, installPath, mimeType);
    if (!wavPath) return null;
    const effectiveMimeType = wavPath !== filePath ? 'audio/wav' : mimeType;

    const port = await findFreePort();
    const child = spawn(serverExe, [
      '-m', modelPath,
      '--host', '127.0.0.1',
      '--port', String(port),
      '--inference-path', '/inference',
      '--no-gpu',
      '-t', '4',
    ], {
      windowsHide: true,
      stdio: 'ignore',
    });

    try {
      await waitForServer(port);
      const text = await requestTranscription(port, wavPath, effectiveMimeType);
      if (!text) return null;

      const transcriptPath = await writeTranscript(filePath, text);
      logger.info(`[OpenWhispr] Transcribed ${path.basename(filePath)} (${text.length} chars)`);
      return { text, transcriptPath };
    } catch (err) {
      logger.warn(`[OpenWhispr] Audio transcription failed: ${err}`);
      return null;
    } finally {
      child.kill();
      if (wavPath !== filePath) {
        fs.promises.unlink(wavPath).catch(() => {});
      }
    }
  }

  private async convertToWavIfNeeded(filePath: string, installPath: string, mimeType?: string): Promise<string | null> {
    if (mimeType === 'audio/wav' || path.extname(filePath).toLowerCase() === '.wav') return filePath;

    const ffmpeg = resolveFfmpegPath({ ffmpegPath: this.options.ffmpegPath, openWhisprPath: installPath });
    if (!ffmpeg) {
      logger.warn('[OpenWhispr] Cannot transcribe audio: no ffmpeg configured or bundled');
      return null;
    }

    const wavPath = replaceExtension(filePath, '.transcribe.wav');
    const args = ['-y', '-i', filePath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath];
    const exitCode = await runProcess(ffmpeg, args);
    if (exitCode !== 0 || !fs.existsSync(wavPath)) {
      logger.warn(`[OpenWhispr] ffmpeg conversion failed for ${filePath}`);
      return null;
    }
    return wavPath;
  }
}

function resolveWhisperServerPath(openWhisprPath: string): string | null {
  const candidates = [
    openWhisprPath,
    path.join(openWhisprPath, 'resources', 'bin', 'whisper-server-win32-x64.exe'),
    path.join(openWhisprPath, 'bin', 'whisper-server-win32-x64.exe'),
  ];
  return candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null;
}

function resolveModelPath(configured?: string): string | null {
  const userHome = process.env.USERPROFILE || process.env.HOME || '';
  const modelDir = path.join(userHome, '.cache', 'openwhispr', 'whisper-models');
  const candidates = [
    configured,
    path.join(modelDir, 'ggml-small.bin'),
    path.join(modelDir, 'ggml-base.bin'),
    path.join(modelDir, 'ggml-tiny.bin'),
    path.join(modelDir, 'ggml-large-v3-turbo.bin'),
  ].filter((candidate): candidate is string => Boolean(candidate?.trim()));

  return candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null;
}

function replaceExtension(filePath: string, extension: string): string {
  return path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))}${extension}`);
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('Could not allocate port'));
      });
    });
    server.on('error', reject);
  });
}

async function waitForServer(port: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw new Error('OpenWhispr server did not start in time');
}

async function requestTranscription(port: number, filePath: string, mimeType?: string): Promise<string | null> {
  const bytes = await fs.promises.readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mimeType || 'audio/wav' }), path.basename(filePath));
  form.append('response_format', 'json');

  const response = await fetch(`http://127.0.0.1:${port}/inference`, {
    method: 'POST',
    body: form,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const data = await response.json() as { text?: unknown };
  const text = typeof data.text === 'string' ? data.text.trim() : '';
  return text || null;
}

async function writeTranscript(audioPath: string, text: string): Promise<string> {
  const transcriptPath = replaceExtension(audioPath, '.transcript.txt');
  await fs.promises.writeFile(transcriptPath, `${text.trim()}\n`, 'utf8');
  return transcriptPath;
}
