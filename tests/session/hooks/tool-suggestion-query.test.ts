import { describe, expect, it } from 'vitest';
import { buildToolSuggestionQuery } from '../../../src/session/hooks/tool-suggestion-query';
import type { HookEvent } from '../../../src/session/hooks/hook-normaliser';

function event(patch: Partial<HookEvent> = {}): HookEvent {
  return {
    cli: 'claude',
    event: 'PostToolUse',
    helmSessionId: 's1',
    receivedAt: 1,
    raw: {},
    ...patch,
  };
}

describe('buildToolSuggestionQuery', () => {
  it('uses tool name, bounded arguments, and result while omitting sensitive argument keys', () => {
    const query = buildToolSuggestionQuery(event({
      toolName: 'Read',
      toolInput: {
        file_path: '/repo/charger.ts',
        auth: { password: 'do-not-include', accessToken: 'also-private' },
        nested: { credential_hint: 'private', topic: 'RS485 baud rate' },
      },
      toolResponse: 'EG004 RS485 uses 9600 baud, 8N1.',
    }));

    expect(query).toContain('tool Read');
    expect(query).toContain('charger.ts');
    expect(query).toContain('RS485 baud rate');
    expect(query).toContain('9600 baud');
    expect(query).not.toContain('do-not-include');
    expect(query).not.toContain('also-private');
    expect(query).not.toContain('private');
  });

  it('caps argument and result text and returns null for an empty event', () => {
    const query = buildToolSuggestionQuery(event({
      toolName: 'Search',
      toolInput: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`field${index}`, 'x'.repeat(200)])),
      toolResponse: 'y'.repeat(2_000),
    }))!;
    const args = query.split('\n')[1]!.slice('arguments '.length);
    const result = query.split('\n')[2]!.slice('result '.length);

    expect(args).toHaveLength(800);
    expect(result).toHaveLength(1_200);
    expect(buildToolSuggestionQuery(event())).toBeNull();
  });

  it('bounds an object result before serializing it and drops its sensitive keys', () => {
    const query = buildToolSuggestionQuery(event({
      toolName: 'Fetch',
      toolResponse: {
        summary: 'RS485 register map',
        apiToken: 'result-secret',
        rows: Array.from({ length: 100_000 }, (_, i) => ({ id: i, text: 'x'.repeat(100) })),
      },
    }));

    expect(query).toContain('RS485 register map');
    expect(query).not.toContain('result-secret');
    expect(query!.length).toBeLessThan(1_400);
  });
});
