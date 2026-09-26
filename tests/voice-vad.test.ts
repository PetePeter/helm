/**
 * Vad — the hands-free speech gate, fed frame energies with explicit times.
 */
import { describe, it, expect } from 'vitest';
import { Vad } from '../renderer/voice/vad';

const opts = { threshold: 0.1, hangoverMs: 800, minSpeechMs: 250, maxSegmentMs: 30_000 };

/** Feed `energy` every 20ms from `from` to `to` (exclusive); collect events. */
function run(vad: Vad, energy: number, from: number, to: number): string[] {
  const events: string[] = [];
  for (let t = from; t < to; t += 20) {
    const e = vad.feed(energy, t);
    if (e) events.push(e);
  }
  return events;
}

describe('Vad', () => {
  it('starts a segment on the first loud frame and ends it after the silence hangover', () => {
    const vad = new Vad(opts);
    expect(run(vad, 0.01, 0, 200)).toEqual([]);
    expect(run(vad, 0.5, 200, 700)).toEqual(['start']);
    expect(run(vad, 0.01, 700, 1480)).toEqual([]);
    expect(run(vad, 0.01, 1480, 1600)).toEqual(['end']);
    expect(vad.speaking).toBe(false);
  });

  it('a pause shorter than the hangover keeps one segment open', () => {
    const vad = new Vad(opts);
    run(vad, 0.5, 0, 400);
    expect(run(vad, 0.01, 400, 1000)).toEqual([]);
    expect(run(vad, 0.5, 1000, 1400)).toEqual([]);
    expect(vad.speaking).toBe(true);
  });

  it('discards a blip shorter than the minimum speech length', () => {
    const vad = new Vad(opts);
    expect(run(vad, 0.5, 0, 100)).toEqual(['start']);
    expect(run(vad, 0.01, 100, 1000)).toEqual(['discard']);
  });

  it('forces an end once a segment reaches the cap', () => {
    const vad = new Vad(opts);
    expect(run(vad, 0.5, 0, 29_990)).toEqual(['start']);
    expect(run(vad, 0.5, 30_000, 30_100)).toEqual(['end', 'start']);
  });

  it('discards a recording that stayed silent for the cap', () => {
    const vad = new Vad(opts);
    expect(run(vad, 0.01, 0, 29_990)).toEqual([]);
    expect(run(vad, 0.01, 30_000, 30_100)).toEqual(['discard']);
    expect(run(vad, 0.01, 30_100, 59_000)).toEqual([]);
  });

  it('reset drops an open segment so paused audio never ends one', () => {
    const vad = new Vad(opts);
    run(vad, 0.5, 0, 400);
    vad.reset();
    expect(run(vad, 0.01, 400, 2000)).toEqual([]);
  });
});
