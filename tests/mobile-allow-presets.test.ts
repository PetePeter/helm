import { describe, expect, it } from 'vitest';
import { ALLOW_PRESETS } from '../renderer/lib/mobile-allow-presets.js';

describe('mobile permission presets', () => {
  it('grants the Artifacts preset only the session-addressed artifact tool family', () => {
    const artifacts = ALLOW_PRESETS.find(preset => preset.label === 'Artifacts');

    expect(artifacts?.globs).toEqual(['session_artifact_*']);
    expect(artifacts?.globs).not.toContain('session_*');
  });
});
