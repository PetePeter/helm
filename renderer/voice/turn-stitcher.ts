/**
 * Joins a hands-free call's spoken segments into one turn, so a breath
 * mid-thought is not "send". Each segment's text keeps the pause before it
 * written inline ("[pause 0.8s]"), so the operator can tell hesitation from
 * separate thoughts. When the turn closes is the call's decision; this only
 * keeps the words and the gaps.
 *
 * The same concept as the phone's TurnStitcher and Timbre's P-1172;
 * deliberately not shared code.
 */

/** Shorter gaps are the VAD's own edges, not a pause worth reading. */
const MIN_MARKED_PAUSE_MS = 300;

export class TurnStitcher {
  private text = '';
  private lastEndMs = 0;

  get pending(): boolean {
    return this.text !== '';
  }

  /** A segment's transcript, spoken from `startMs` to `endMs`. Blank text adds nothing. */
  add(text: string, startMs: number, endMs: number): void {
    const words = text.trim();
    if (!words) return;
    if (this.pending) {
      const gap = startMs - this.lastEndMs;
      this.text += gap >= MIN_MARKED_PAUSE_MS ? ` [pause ${(gap / 1000).toFixed(1)}s] ` : ' ';
    }
    this.text += words;
    this.lastEndMs = endMs;
  }

  /** The turn so far, and start a new one. */
  take(): string {
    const text = this.text;
    this.text = '';
    return text;
  }
}
