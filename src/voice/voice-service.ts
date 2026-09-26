/**
 * VoiceService — desktop hold-to-talk over the SAME local STT/TTS Telegram uses
 * (docs/voice-operator.md). It adds no engine of its own: OpenWhispr turns the
 * recorded clip into text, Piper turns the operator's reply into OGG/Opus, which
 * Chromium plays natively.
 *
 * Every temp file lives under the app-data temp dir (config boundary) and is
 * deleted on success AND failure — a clip of the user's voice must not linger.
 * Results are values, never throws: the renderer shows `error` as-is, and a
 * missing tool is reported before anything is spawned.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { OpenWhisprTranscriber, type AudioTranscriber } from './openwhispr-transcriber.js';
import { PiperTts } from './piper-tts.js';
import type { VoiceToolCapabilities } from '../session/capability-detector.js';
import { logger } from '../utils/logger.js';

export type VoiceTools = VoiceToolCapabilities;

/** The voice slice of the Telegram settings, where the tool paths are configured. */
export interface VoiceToolConfig {
  openWhisprPath?: string;
  openWhisprModelPath?: string;
  piperPath?: string;
  piperVoicePath?: string;
  ffmpegPath?: string;
}

export interface VoiceSynthesizer {
  synthesize(text: string): Promise<{ oggPath: string }>;
}

export type VoiceResult<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };

export interface VoiceServiceDeps {
  getConfig: () => VoiceToolConfig;
  getTools: () => VoiceTools;
  tempDir: string;
  createTranscriber?: (config: VoiceToolConfig) => AudioTranscriber;
  createTts?: (config: VoiceToolConfig, tmpDir: string) => VoiceSynthesizer;
}

const CONFIGURE_HINT = 'configure it in Settings → Telegram';

const EXTENSION_BY_MIME: Record<string, string> = {
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/mp4': '.m4a',
};

export class VoiceService {
  private readonly createTranscriber: (config: VoiceToolConfig) => AudioTranscriber;
  private readonly createTts: (config: VoiceToolConfig, tmpDir: string) => VoiceSynthesizer;

  constructor(private readonly deps: VoiceServiceDeps) {
    this.createTranscriber = deps.createTranscriber ?? (config => new OpenWhisprTranscriber({
      openWhisprPath: config.openWhisprPath,
      modelPath: config.openWhisprModelPath,
      ffmpegPath: config.ffmpegPath,
    }));
    this.createTts = deps.createTts ?? ((config, tmpDir) => new PiperTts({
      piperPath: config.piperPath,
      piperVoicePath: config.piperVoicePath,
      ffmpegPath: config.ffmpegPath,
      tmpDir,
    }));
  }

  async transcribe(audio: Uint8Array, mimeType: string): Promise<VoiceResult<{ text: string }>> {
    if (!audio || audio.byteLength === 0) return { ok: false, error: 'No audio was recorded' };
    if (!this.deps.getTools().openwhisper) {
      return { ok: false, error: `OpenWhispr (speech-to-text) is not configured — ${CONFIGURE_HINT}` };
    }

    await fs.promises.mkdir(this.deps.tempDir, { recursive: true });
    const clipPath = path.join(this.deps.tempDir, `voice-in-${stamp()}${extensionFor(mimeType)}`);
    let transcriptPath: string | undefined;
    try {
      await fs.promises.writeFile(clipPath, audio);
      const result = await this.createTranscriber(this.deps.getConfig()).transcribe(clipPath, baseMime(mimeType));
      transcriptPath = result?.transcriptPath;
      const text = result?.text.trim();
      return text ? { ok: true, text } : { ok: false, error: 'No speech was recognised' };
    } catch (err) {
      logger.warn(`[Voice] Transcription failed: ${err}`);
      return { ok: false, error: `Transcription failed: ${describe(err)}` };
    } finally {
      await removeQuietly(clipPath);
      if (transcriptPath) await removeQuietly(transcriptPath);
    }
  }

  async speak(text: string): Promise<VoiceResult<{ audio: Uint8Array; mimeType: string }>> {
    if (!text || text.trim() === '') return { ok: false, error: 'Nothing to speak: text is empty' };
    const tools = this.deps.getTools();
    if (!tools.piper) return { ok: false, error: `Piper (text-to-speech) is not configured — ${CONFIGURE_HINT}` };
    if (!tools.ffmpeg) return { ok: false, error: `ffmpeg (audio conversion) is not configured — ${CONFIGURE_HINT}` };

    let oggPath: string | undefined;
    try {
      ({ oggPath } = await this.createTts(this.deps.getConfig(), this.deps.tempDir).synthesize(text));
      const audio = new Uint8Array(await fs.promises.readFile(oggPath));
      return { ok: true, audio, mimeType: 'audio/ogg' };
    } catch (err) {
      logger.warn(`[Voice] Speech synthesis failed: ${err}`);
      return { ok: false, error: `Speech synthesis failed: ${describe(err)}` };
    } finally {
      if (oggPath) await removeQuietly(oggPath);
    }
  }
}

function stamp(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** `audio/webm;codecs=opus` → `audio/webm`. */
function baseMime(mimeType: string): string {
  return mimeType.split(';')[0].trim().toLowerCase();
}

function extensionFor(mimeType: string): string {
  return EXTENSION_BY_MIME[baseMime(mimeType)] ?? '.webm';
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function removeQuietly(filePath: string): Promise<void> {
  await fs.promises.unlink(filePath).catch(() => {});
}
