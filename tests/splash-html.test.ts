/**
 * The splash window is frameless, fixed at 460x320 and not resizable, so a
 * scrollbar there is always a bug. Regression guard for that CSS only.
 */

import { describe, it, expect } from 'vitest';
import { buildSplashHtml } from '../src/electron/splash-html.js';

describe('buildSplashHtml', () => {
  it('locks the body to the viewport so the fixed window cannot scroll', () => {
    const html = buildSplashHtml('1.2.3');
    const body = html.match(/body\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(body).toContain('overflow: hidden');
    expect(body).toContain('height: 100vh');
    expect(body).not.toContain('min-height');
  });

  it('escapes the version it renders', () => {
    expect(buildSplashHtml('1.0.0"><script>')).not.toContain('<script>');
  });
});
