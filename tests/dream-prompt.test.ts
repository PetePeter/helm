import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DREAM_PROMPT,
  DREAM_IDEA_PROMPT_MARKER,
} from '../src/types/dreaming.js';
import {
  buildDreamPrompt,
  DREAM_MESS_CUE,
  DREAM_UNATTENDED_CUE,
} from '../src/session/scheduled-task-manager.js';

describe('dream prompt', () => {
  it('assembles the shipped idea procedure with the existing cues and project addendum', () => {
    const addendum = 'Keep this project addendum.';
    const prompt = buildDreamPrompt(DEFAULT_DREAM_PROMPT, addendum);
    const positions = [
      prompt.indexOf(DREAM_IDEA_PROMPT_MARKER),
      prompt.indexOf(DREAM_UNATTENDED_CUE),
      prompt.indexOf(addendum),
      prompt.indexOf(DREAM_MESS_CUE),
    ];

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(prompt).toContain('plan_create');
    expect(prompt).toContain('sourceIdeaId');
    expect(prompt).toContain('Do not edit code');
  });
});
