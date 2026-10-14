/**
 * The headless command is only ever the one saved on a CLI type. These guard
 * the two places a suggestion reaches the user: the Tool Editor's field and
 * the defaults a fresh install is seeded with.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as YAML from 'yaml';
import {
  SUGGESTED_HEADLESS_COMMANDS,
  headlessCommandProblem,
  headlessCommandToEdit,
} from '../src/session/headless-command.js';

describe('headless command suggestions', () => {
  it('offers the family suggestion in the editor only when the type has no command of its own', () => {
    expect(headlessCommandToEdit({ provider: 'claude' })).toBe(SUGGESTED_HEADLESS_COMMANDS.claude);
    expect(headlessCommandToEdit({ provider: 'codex', headlessCommand: '   ' })).toBe(SUGGESTED_HEADLESS_COMMANDS.codex);
    expect(headlessCommandToEdit({ provider: 'claude', headlessCommand: 'mine < "{promptFile}" > "{outputFile}"' }))
      .toBe('mine < "{promptFile}" > "{outputFile}"');
  });

  it('offers nothing for a family with no way to run headless, or no family', () => {
    expect(headlessCommandToEdit({ provider: 'copilot' })).toBe('');
    expect(headlessCommandToEdit({ provider: null })).toBe('');
    expect(headlessCommandToEdit({})).toBe('');
  });

  it('suggests only commands that can actually run', () => {
    for (const command of Object.values(SUGGESTED_HEADLESS_COMMANDS)) {
      expect(headlessCommandProblem(command)).toBeUndefined();
    }
  });

  it('seeds a fresh install with the same command the editor would suggest', () => {
    const shipped = YAML.parse(readFileSync(resolve(__dirname, '../src/config/cli-types.yaml'), 'utf8')) as
      Record<string, { provider?: 'claude' | 'codex' | 'copilot'; headlessCommand?: string }>;
    const byProvider = Object.values(shipped)
      .filter(type => type.provider && SUGGESTED_HEADLESS_COMMANDS[type.provider])
      .map(type => [type.provider, type.headlessCommand]);
    expect(byProvider.length).toBeGreaterThan(0);
    for (const [provider, command] of byProvider) {
      expect(command, `shipped ${provider} type`).toBe(SUGGESTED_HEADLESS_COMMANDS[provider as 'claude' | 'codex']);
    }
  });
});
