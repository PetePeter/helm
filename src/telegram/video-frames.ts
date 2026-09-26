// src/telegram/video-frames.ts

/**
 * Turn a video file into still frames an AI agent can actually look at.
 *
 * A video path on its own is opaque — the agent cannot perceive it. Extracting
 * an evenly-spread contact sheet gives it a first impression of the whole clip;
 * from there the agent seeks specific timestamps itself with the ffmpeg command
 * advertised in the attachment envelope. That keeps the expensive part (deciding
 * *which* moment matters) with the agent instead of hardcoding a sampling policy.
 *
 * Frames are written beside the video so they share its temp-dir lifetime.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { runProcess } from '../voice/ffmpeg.js';
import { logger } from '../utils/logger.js';

/** Enough to see the shape of a clip; more just burns context. */
export const DEFAULT_FRAME_COUNT = 6;

export interface VideoFrameOptions {
  videoPath: string;
  /** Resolved ffmpeg executable, or null when unavailable. */
  ffmpegPath: string | null;
  /** Clip length in seconds, when Telegram reported one. */
  durationSec?: number;
  maxFrames?: number;
}

/**
 * Extract evenly-spread frames as JPEGs.
 * Returns the frame paths in chronological order, or [] on any failure —
 * frames are a bonus on top of the attachment, never a reason to lose it.
 */
export async function extractVideoFrames(options: VideoFrameOptions): Promise<string[]> {
  const { videoPath, ffmpegPath } = options;
  if (!ffmpegPath) return [];

  const frameCount = Math.max(1, options.maxFrames ?? DEFAULT_FRAME_COUNT);
  const pattern = frameOutputPattern(videoPath);

  // With a known duration, sample at exactly frameCount points across the clip.
  // Without one, `thumbnail` picks representative frames instead of blindly
  // taking the first N, which on a static opening shot would all look alike.
  const selectFilter = options.durationSec && options.durationSec > 0
    ? `fps=${frameCount}/${options.durationSec}`
    : `thumbnail`;

  const exitCode = await runProcess(ffmpegPath, [
    '-y',
    '-i', videoPath,
    '-vf', `${selectFilter},scale=-2:360`,
    '-frames:v', String(frameCount),
    '-q:v', '3',
    pattern,
  ]);

  const frames = await collectFramesWhenSettled(videoPath, frameCount);
  if (exitCode !== 0 && frames.length === 0) {
    logger.warn(`[VideoFrames] ffmpeg produced no frames for ${path.basename(videoPath)} (exit ${exitCode})`);
    return [];
  }

  logger.info(`[VideoFrames] Extracted ${frames.length} frame(s) from ${path.basename(videoPath)}`);
  return frames;
}

/** The ffmpeg recipe the agent uses to pull any additional timestamp itself. */
export function buildFrameSeekHint(ffmpegPath: string, videoPath: string): string {
  return `"${ffmpegPath}" -y -ss <seconds> -i "${videoPath}" -frames:v 1 -q:v 2 <out.jpg>`;
}

function frameOutputPattern(videoPath: string): string {
  return path.join(path.dirname(videoPath), `${baseName(videoPath)}.frame%d.jpg`);
}

/**
 * ffmpeg's exit does not guarantee every JPEG is visible at full size yet — on
 * Windows the last file it wrote can still read as 0 bytes for a few
 * milliseconds. Scanning once dropped that frame silently, so re-scan while the
 * count is still growing and stop as soon as it holds steady.
 */
async function collectFramesWhenSettled(videoPath: string, frameCount: number): Promise<string[]> {
  let frames = collectFrames(videoPath, frameCount);

  for (let attempt = 0; attempt < SETTLE_ATTEMPTS && frames.length < frameCount; attempt++) {
    await delay(SETTLE_INTERVAL_MS);
    const rescanned = collectFrames(videoPath, frameCount);
    if (rescanned.length === frames.length) break;
    frames = rescanned;
  }

  return frames;
}

/** Bounded so a genuinely short clip costs one extra scan, not a stall. */
const SETTLE_ATTEMPTS = 3;
const SETTLE_INTERVAL_MS = 100;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * ffmpeg numbers its output from 1, so probe that range rather than globbing —
 * the temp dir also holds frames from other videos.
 */
function collectFrames(videoPath: string, frameCount: number): string[] {
  const dir = path.dirname(videoPath);
  const base = baseName(videoPath);
  const frames: string[] = [];

  for (let index = 1; index <= frameCount; index++) {
    const candidate = path.join(dir, `${base}.frame${index}.jpg`);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).size > 0) frames.push(candidate);
    } catch {
      // A frame we cannot stat is simply not offered to the agent.
    }
  }

  return frames;
}

function baseName(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}
