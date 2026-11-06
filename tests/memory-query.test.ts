import { describe, expect, it } from 'vitest';
import { rankMemories } from '../src/session/memory-search.js';
import { isQueryExpression, parseQueryExpression } from '../src/session/memory-query.js';
import type { MemoryRecord } from '../src/types/memory.js';

function memory(id: string, tldr: string, content = ''): MemoryRecord {
  return { id, tldr, content } as MemoryRecord;
}

const STORE = [
  memory('m1', 'Car crossed the old bridge', 'The car stopped just before the bridge at dawn.'),
  memory('m2', 'Bridge inspection', 'Engineers inspected the bridge. Many weeks and several long reports later, one car arrived.'),
  memory('m3', 'Deploy checklist', 'Run prepareDeploy then sendDeploy. Never publish drafts.'),
  memory('m4', 'Release notes', 'How we release the Android draft build.'),
];

const ids = (query: string) => rankMemories(STORE, query).map((hit) => hit.id);

describe('memory query expressions', () => {
  it('leaves plain queries on the plain BM25 path', () => {
    expect(isQueryExpression('car bridge')).toBe(false);
    expect(isQueryExpression('car NEAR/5 bridge')).toBe(true);
    expect(isQueryExpression('deploy*')).toBe(true);
  });

  it('NEAR/n keeps only memories where the words are within n words', () => {
    expect(ids('car NEAR/5 bridge')).toEqual(['m1']);
    expect(ids('car near5 bridge')).toEqual(['m1']);
    expect(ids('car NEAR/40 bridge').sort()).toEqual(['m1', 'm2']);
  });

  it('ONEAR/n also requires the order', () => {
    expect(ids('car ONEAR/4 bridge')).toEqual(['m1']);
    expect(ids('bridge ONEAR/1 car')).toEqual([]);
  });

  it('AND, OR, NOT and parentheses combine with the usual precedence', () => {
    expect(ids('bridge AND car AND NOT inspection')).toEqual(['m1']);
    expect(ids('(deploy* OR release) AND -android')).toEqual(['m3']);
    expect(ids('(deploy* OR release) AND draft*').sort()).toEqual(['m3', 'm4']);
  });

  it('"exact phrase" matches consecutive words only', () => {
    expect(ids('"old bridge"')).toEqual(['m1']);
    expect(ids('"bridge old"')).toEqual([]);
  });

  it('prefix* finds a word inside a camel-case token and word~ tolerates a typo', () => {
    expect(ids('preparedeploy~')).toEqual(['m3']);
    expect(ids('inspec*')).toEqual(['m2']);
    expect(ids('inspektion~')).toEqual(['m2']);
  });

  it('rejects malformed expressions with a readable error', () => {
    expect(() => parseQueryExpression('(car AND')).toThrow(/Invalid query expression/);
    expect(() => parseQueryExpression('"car bridge')).toThrow(/unclosed quote/);
    expect(() => parseQueryExpression('car )')).toThrow(/unexpected/);
  });
});
