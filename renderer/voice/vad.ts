/**
 * Voice-activity gate for the hands-free call. Pure: fed one RMS energy per
 * audio frame with its timestamp, so it runs under test without WebAudio.
 *
 * A frame above `threshold` opens a segment ('start'). The segment closes once
 * the voice has been quiet for `hangoverMs` — 'end' when it held speech for at
 * least `minSpeechMs`, else 'discard' (a cough, a click, a door).
 *
 * `maxSegmentMs` bounds every recording: a segment that long is forced to
 * 'end', and a recording that long with no speech at all is 'discard'ed so the
 * caller can drop it and start afresh.
 */
export interface VadOptions {
  threshold: number;
  hangoverMs: number;
  minSpeechMs: number;
  maxSegmentMs: number;
}

export type VadEvent = 'start' | 'end' | 'discard';

export const DEFAULT_VAD_OPTIONS: VadOptions = {
  threshold: 0.02, hangoverMs: 800, minSpeechMs: 250, maxSegmentMs: 30_000,
};

export class Vad {
  private startedAt: number | null = null;
  private lastLoudAt = 0;
  /** First frame of the current recording (since construction, reset, or a closed segment). */
  private openedAt: number | null = null;

  constructor(private readonly options: VadOptions = DEFAULT_VAD_OPTIONS) {}

  get speaking(): boolean {
    return this.startedAt !== null;
  }

  feed(energy: number, atMs: number): VadEvent | null {
    this.openedAt ??= atMs;
    if (this.startedAt !== null && atMs - this.startedAt >= this.options.maxSegmentMs) {
      return this.close('end');
    }
    if (energy >= this.options.threshold) {
      this.lastLoudAt = atMs;
      if (this.startedAt !== null) return null;
      this.startedAt = atMs;
      return 'start';
    }
    if (this.startedAt === null) {
      return atMs - this.openedAt >= this.options.maxSegmentMs ? this.close('discard') : null;
    }
    if (atMs - this.lastLoudAt < this.options.hangoverMs) return null;
    const spokeFor = this.lastLoudAt - this.startedAt;
    return this.close(spokeFor >= this.options.minSpeechMs ? 'end' : 'discard');
  }

  /** Forget any open segment and recording — used while the mic is paused. */
  reset(): void {
    this.startedAt = null;
    this.openedAt = null;
  }

  private close(event: VadEvent): VadEvent {
    this.reset();
    return event;
  }
}
