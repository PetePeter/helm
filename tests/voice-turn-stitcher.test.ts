import { describe, it, expect } from 'vitest';
import { TurnStitcher } from '../renderer/voice/turn-stitcher';

describe('TurnStitcher', () => {
  it('joins segments with the pause before each written inline', () => {
    const turn = new TurnStitcher();
    turn.add('check the build', 0, 1000);
    turn.add('and run the tests', 1800, 3000);
    expect(turn.take()).toBe('check the build [pause 0.8s] and run the tests');
  });

  it('joins a gap shorter than a real pause unmarked', () => {
    const turn = new TurnStitcher();
    turn.add('check', 0, 1000);
    turn.add('the build', 1200, 2000);
    expect(turn.take()).toBe('check the build');
  });

  it('ignores blank segments, and take starts a fresh turn', () => {
    const turn = new TurnStitcher();
    turn.add('   ', 0, 500);
    expect(turn.pending).toBe(false);
    turn.add('first', 1000, 1500);
    expect(turn.take()).toBe('first');
    expect(turn.pending).toBe(false);
    turn.add('second', 9000, 9500);
    expect(turn.take()).toBe('second');
  });
});
