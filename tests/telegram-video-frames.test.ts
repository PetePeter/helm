import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { resolveFfmpegPath } from '../src/voice/ffmpeg.js';
import { extractVideoFrames } from '../src/telegram/video-frames.js';

/**
 * Locate a system ffmpeg for the test run only. Production deliberately does
 * NOT search PATH — resolution there is config-driven so behaviour cannot vary
 * with whatever happens to be installed on the machine.
 */
function findFfmpegOnPath(): string | undefined {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return dirs.map(dir => path.join(dir, exe)).find(candidate => existsSync(candidate));
}

// These tests drive the real ffmpeg binary against a real generated clip.
// Mocking ffmpeg would only assert that we can build an argv string; the thing
// worth protecting is that frames actually land on disk and are readable.
const ffmpeg = resolveFfmpegPath({ ffmpegPath: process.env.HELM_TEST_FFMPEG ?? findFfmpegOnPath() });
if (!ffmpeg) {
  // Skipping silently would let the frame pipeline rot unnoticed in CI.
  console.warn('[telegram-video-frames] ffmpeg not found — frame extraction tests skipped');
}
const describeWithFfmpeg = ffmpeg ? describe : describe.skip;

let workDir: string;
let videoPath: string;

beforeAll(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'helm-frames-'));
  if (!ffmpeg) return;
  videoPath = path.join(workDir, 'clip.mp4');
  execFileSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10:duration=6',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath,
  ], { stdio: 'ignore' });
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describeWithFfmpeg('extractVideoFrames', () => {
  it('writes the requested number of non-empty frames', async () => {
    const frames = await extractVideoFrames({
      videoPath,
      ffmpegPath: ffmpeg,
      durationSec: 6,
      maxFrames: 4,
    });

    expect(frames).toHaveLength(4);
    for (const frame of frames) {
      expect(statSync(frame).size).toBeGreaterThan(0);
    }
  });

  // Regression: a frame ffmpeg had written but not yet flushed read as 0 bytes,
  // so the scan dropped it and the agent was never told it existed.
  it('advertises every frame ffmpeg actually wrote', async () => {
    const clip = path.join(workDir, 'settle.mp4');
    execFileSync(ffmpeg!, [
      '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10:duration=6',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip,
    ], { stdio: 'ignore' });

    const frames = await extractVideoFrames({ videoPath: clip, ffmpegPath: ffmpeg, durationSec: 6 });

    const onDisk = readdirSync(workDir).filter(name => name.startsWith('settle.frame') && name.endsWith('.jpg'));
    expect(frames).toHaveLength(onDisk.length);
  });

  it('still extracts frames when duration is unknown', async () => {
    const frames = await extractVideoFrames({
      videoPath,
      ffmpegPath: ffmpeg,
      maxFrames: 3,
    });

    expect(frames.length).toBeGreaterThan(0);
  });

  it('returns [] for a corrupt video rather than throwing', async () => {
    const corrupt = path.join(workDir, 'corrupt.mp4');
    writeFileSync(corrupt, 'not a video');

    await expect(
      extractVideoFrames({ videoPath: corrupt, ffmpegPath: ffmpeg, durationSec: 5 }),
    ).resolves.toEqual([]);
  });
});

describe('extractVideoFrames without ffmpeg', () => {
  it('returns [] when ffmpeg is not available', async () => {
    await expect(
      extractVideoFrames({ videoPath: 'anything.mp4', ffmpegPath: null }),
    ).resolves.toEqual([]);
  });
});

describe('resolveFfmpegPath', () => {
  it('prefers an existing configured path over every fallback', () => {
    const configured = path.join(workDir, 'my-ffmpeg.exe');
    writeFileSync(configured, '');

    expect(resolveFfmpegPath({ ffmpegPath: configured })).toBe(configured);
  });

  it('never returns a configured path that does not exist on disk', () => {
    const missing = path.join(tmpdir(), 'no-such-ffmpeg.exe');

    expect(resolveFfmpegPath({ ffmpegPath: missing })).not.toBe(missing);
  });

  it('falls back to the OpenWhispr bundle when no path is configured', () => {
    const bundled = path.join(workDir, 'resources', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
    mkdirSync(path.dirname(bundled), { recursive: true });
    writeFileSync(bundled, '');

    expect(resolveFfmpegPath({ openWhisprPath: workDir })).toBe(bundled);
  });

  it('never searches PATH — resolution must stay config-driven', () => {
    expect(resolveFfmpegPath({})).toBeNull();
  });
});
