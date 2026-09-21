import { describe, it, expect } from 'vitest';
import { buildToolEditorOptions } from '../../renderer/stores/modal-bridge.js';

describe('buildToolEditorOptions', () => {
  it('trims command fields and includes them in output', () => {
    const values = {
      spawnCommand: '  claude  ',
      resumeCommand: '  claude --resume  ',
      continueCommand: '',
      renameCommand: ' rename-me ',
      env: [],
      helmPreambleForInterSession: true,
    };
    const result = buildToolEditorOptions(values);
    expect(result.spawnCommand).toBe('claude');
    expect(result.resumeCommand).toBe('claude --resume');
    expect(result.continueCommand).toBe('');
    expect(result.renameCommand).toBe('rename-me');
  });

  it('handles non-string command fields gracefully', () => {
    const values = {
      spawnCommand: 123,
      resumeCommand: null,
      continueCommand: undefined,
      renameCommand: '',
      env: [],
    };
    const result = buildToolEditorOptions(values);
    expect(result.spawnCommand).toBe('');
    expect(result.resumeCommand).toBe('');
    expect(result.continueCommand).toBe('');
  });

  it('preserves env entries with mode field (append/prepend)', () => {
    const values = {
      env: [
        { name: ' PATH ', value: '/usr/bin', mode: 'append' },
        { name: 'HOME', value: '/home/user', mode: 'prepend' },
        { name: 'EDITOR', value: 'vim' }, // no mode — default replace
      ],
    };
    const result = buildToolEditorOptions(values);
    expect(result.env).toHaveLength(3);
    expect(result.env![0]).toEqual({ name: 'PATH', value: '/usr/bin', mode: 'append' });
    expect(result.env![1]).toEqual({ name: 'HOME', value: '/home/user', mode: 'prepend' });
    expect(result.env![2]).toEqual({ name: 'EDITOR', value: 'vim' });
  });

  it('filters out env entries with empty names after trim', () => {
    const values = {
      env: [
        { name: 'VALID', value: 'val' },
        { name: '', value: 'empty-name' },
        { name: '   ', value: 'whitespace-name' },
      ],
    };
    const result = buildToolEditorOptions(values);
    expect(result.env).toHaveLength(1);
    expect(result.env![0].name).toBe('VALID');
  });

  it('handles non-array env gracefully', () => {
    const result = buildToolEditorOptions({ env: 'not-array' });
    expect(result.env).toEqual([]);
  });

  it('handles env items with non-string names/values', () => {
    const values = {
      env: [
        { name: 42, value: 'val' },
        { name: 'VALID', value: null },
      ],
    };
    const result = buildToolEditorOptions(values);
    expect(result.env).toHaveLength(1); // non-string name becomes '', filtered out; VALID survives
    expect(result.env![0]).toEqual({ name: 'VALID', value: '' });
  });

  it('defaults helmPreambleForInterSession to true, respects explicit false', () => {
    expect(buildToolEditorOptions({}).helmPreambleForInterSession).toBe(true);
    expect(buildToolEditorOptions({ helmPreambleForInterSession: true }).helmPreambleForInterSession).toBe(true);
    expect(buildToolEditorOptions({ helmPreambleForInterSession: false }).helmPreambleForInterSession).toBe(false);
  });

  it('sets largeTextAsTempFile as boolean', () => {
    expect(buildToolEditorOptions({}).largeTextAsTempFile).toBe(false);
    expect(buildToolEditorOptions({ largeTextAsTempFile: true }).largeTextAsTempFile).toBe(true);
    expect(buildToolEditorOptions({ largeTextAsTempFile: false }).largeTextAsTempFile).toBe(false);
  });

  it('defaults submitSuffix to \\r when absent or non-string', () => {
    expect(buildToolEditorOptions({}).submitSuffix).toBe('\\r');
    expect(buildToolEditorOptions({ submitSuffix: undefined }).submitSuffix).toBe('\\r');
    expect(buildToolEditorOptions({ submitSuffix: 42 }).submitSuffix).toBe('\\r');
    expect(buildToolEditorOptions({ submitSuffix: '' }).submitSuffix).toBe('');   // empty string is valid, not treated as falsy
  });

  it('returns complete options with all fields populated', () => {
    const values = {
      spawnCommand: 'claude --dangerously-skip-permissions',
      resumeCommand: 'claude --resume',
      continueCommand: '/continue',
      renameCommand: '/rename',
      env: [{ name: 'API_KEY', value: 'secret', mode: 'append' }],
      helmPreambleForInterSession: false,
      largeTextAsTempFile: true,
      submitSuffix: '\\r',
    };
    const result = buildToolEditorOptions(values);
    expect(result).toEqual({
      spawnCommand: 'claude --dangerously-skip-permissions',
      resumeCommand: 'claude --resume',
      continueCommand: '/continue',
      renameCommand: '/rename',
      env: [{ name: 'API_KEY', value: 'secret', mode: 'append' }],
      helmPreambleForInterSession: false,
      largeTextAsTempFile: true,
      // Absent from the input and still present here: the default is on, and the
      // options builder always states it so a CLI type cannot inherit silence.
      messReminders: true,
      submitSuffix: '\\r',
      helmActions: { clear: '', compact: '', export: '' },
    });
  });

  it('trims helmActions fields and defaults to empty strings', () => {
    expect(buildToolEditorOptions({}).helmActions).toEqual({ clear: '', compact: '', export: '' });

    const result = buildToolEditorOptions({
      helmActions: { clear: '  /clear{Enter} ', compact: '/compact $instruction{Enter}', export: 42 as any },
    });
    expect(result.helmActions).toEqual({
      clear: '/clear{Enter}',
      compact: '/compact $instruction{Enter}',
      export: '', // non-string coerced to empty
    });
  });
});
