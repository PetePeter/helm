import { describe, expect, it } from 'vitest';
import { decodeBase64Strict, decodeBase64StrictOrThrow } from '../src/utils/base64.js';
import { escapeHtmlAttribute, escapeHtmlText } from '../src/utils/html.js';

describe('shared low-level utilities', () => {
  it('escapes HTML text nodes without changing quote output', () => {
    expect(escapeHtmlText(`A&B <tag> "quoted" 'single'`))
      .toBe(`A&amp;B &lt;tag&gt; "quoted" 'single'`);
  });

  it('escapes HTML attribute values with quote handling', () => {
    expect(escapeHtmlAttribute(`A&B <tag> "quoted" 'single'`))
      .toBe('A&amp;B &lt;tag&gt; &quot;quoted&quot; &#x27;single&#x27;');
  });

  it('shares strict base64 decoding with throwing and nullable call sites', () => {
    expect(decodeBase64Strict('aGVs bG8=')?.toString('utf8')).toBe('hello');
    expect(decodeBase64Strict('not base64!')).toBeNull();
    expect(decodeBase64StrictOrThrow('aGVsbG8=')?.toString('utf8')).toBe('hello');
    expect(() => decodeBase64StrictOrThrow('not base64!', 'custom base64 error')).toThrow('custom base64 error');
  });
});

