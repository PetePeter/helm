import { describe, expect, it } from 'vitest';
import {
  FIELD_PLACEHOLDERS,
  fillTemplate,
  sessionTemplateValues,
  unknownPlaceholders,
} from '../src/config/template-placeholders.js';

describe('fillTemplate', () => {
  it('fills every known {name}, leaves unknown and escaped braces alone', () => {
    expect(fillTemplate('a {x} {y} {{x}} {z}', { x: '1', y: '2' })).toBe('a 1 2 {{x}} {z}');
  });

  it('accepts the legacy $instruction / $path / $instructions spellings, whole tokens only', () => {
    const values = { instruction: 'focus', path: 'C:/out.md' };
    expect(fillTemplate('/compact $instruction{Enter}', values)).toBe('/compact focus{Enter}');
    expect(fillTemplate('/compact $instructions{Enter}', values)).toBe('/compact focus{Enter}');
    expect(fillTemplate('/export $path{Enter}', values)).toBe('/export C:/out.md{Enter}');
    expect(fillTemplate('echo $pathology $HOME', values)).toBe('echo $pathology $HOME');
  });

  it('never fills a $name that is not a legacy action placeholder', () => {
    expect(fillTemplate('cmd $cliSessionName', { cliSessionName: 'abc' })).toBe('cmd $cliSessionName');
  });
});

describe('sessionTemplateValues', () => {
  it('falls back to the Helm name until a hook reports the CLI thread id', () => {
    expect(sessionTemplateValues('helm-uuid')).toEqual({ cliSessionName: 'helm-uuid', cliThreadId: 'helm-uuid' });
    expect(sessionTemplateValues('helm-uuid', 'thread-1')).toEqual({ cliSessionName: 'helm-uuid', cliThreadId: 'thread-1' });
  });

  it('fills both ids in every session command field', () => {
    for (const field of ['spawnCommand', 'resumeCommand', 'continueCommand', 'renameCommand'] as const) {
      expect(FIELD_PLACEHOLDERS[field].map(p => p.name)).toEqual(['cliSessionName', 'cliThreadId']);
    }
  });
});

describe('unknownPlaceholders', () => {
  it('flags a typo in a command field', () => {
    expect(unknownPlaceholders('resumeCommand', 'claude --resume={cliThreadID}')).toEqual(['cliThreadID']);
    expect(unknownPlaceholders('resumeCommand', 'claude --resume={cliThreadId}')).toEqual([]);
  });

  it('does not accept another field\'s placeholders', () => {
    expect(unknownPlaceholders('spawnCommand', 'x < "{promptFile}"')).toEqual(['promptFile']);
  });

  it('accepts sequence keys only in sequence fields', () => {
    expect(unknownPlaceholders('compact', '/compact {instruction}{Wait 200}{Enter}{Ctrl+C}{NoSend}')).toEqual([]);
    expect(unknownPlaceholders('compact', '/compact {Entr}')).toEqual(['Entr']);
    expect(unknownPlaceholders('spawnCommand', 'claude {Enter}')).toEqual(['Enter']);
  });

  it('ignores escaped braces', () => {
    expect(unknownPlaceholders('spawnCommand', 'echo {{literal}}')).toEqual([]);
  });
});
