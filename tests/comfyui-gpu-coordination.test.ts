import { describe, expect, it } from 'vitest';
import { parseLoadedModelsOutput } from '../src/session/comfyui/gpu-coordination.js';

describe('ComfyUI GPU coordination', () => {
  it('treats a missing LM Studio CLI as unavailable', () => {
    expect(parseLoadedModelsOutput('__HELM_LM_STUDIO_CLI_MISSING__')).toBeNull();
  });

  it('treats an empty LM Studio model list as idle', () => {
    expect(parseLoadedModelsOutput('')).toEqual([]);
  });

  it('preserves loaded-model details for existing GPU checks', () => {
    const models = [{ modelKey: 'model-key', identifier: 'model-id' }];

    expect(parseLoadedModelsOutput(JSON.stringify(models))).toEqual(models);
  });

  it('rejects malformed LM Studio model output', () => {
    expect(() => parseLoadedModelsOutput('{')).toThrow();
  });
});
