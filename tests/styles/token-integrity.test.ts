/**
 * Token integrity — guards the undefined-custom-property bug class.
 *
 * A `var(--x)` written WITHOUT a fallback silently resolves to nothing when
 * `--x` is defined nowhere: borders vanish, backgrounds drop out, font sizes
 * inherit. That is currently shipping in several modals, and it is invisible in
 * jsdom because jsdom does not evaluate stylesheets — so it needs a static check.
 *
 * Deliberately narrow. A property counts as defined if ANY renderer file
 * declares it (`:root`, a scoped component block, anywhere), because scoped
 * component variables are legitimate.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import postcss from 'postcss';

const RENDERER = resolve(__dirname, '../../renderer');

const SCANNED_EXTENSIONS = ['.css', '.vue', '.ts'];

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectFiles(full, out);
    } else if (SCANNED_EXTENSIONS.some((ext) => full.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

/** Every custom property declared anywhere in the renderer. */
function collectDefined(files: string[]): Set<string> {
  const defined = new Set<string>();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    // Declarations in real CSS, plus JS object keys like '--foo': ...
    for (const match of source.matchAll(/(--[a-zA-Z0-9-]+)\s*'?\s*:/g)) {
      defined.add(match[1]);
    }
  }
  return defined;
}

/**
 * Every `var(--x)` used with no fallback, i.e. `var(--x)` and not
 * `var(--x, something)`. Those with a fallback degrade gracefully.
 */
function collectUsedWithoutFallback(files: string[]): Map<string, string[]> {
  const used = new Map<string, string[]>();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*\)/g)) {
      const token = match[1];
      const sites = used.get(token) ?? [];
      sites.push(file.replace(RENDERER, 'renderer'));
      used.set(token, sites);
    }
  }
  return used;
}

describe('CSS custom property integrity', () => {
  const files = collectFiles(RENDERER);

  it('main.css parses as valid CSS', () => {
    const css = readFileSync(join(RENDERER, 'styles/main.css'), 'utf8');
    expect(() => postcss.parse(css)).not.toThrow();
  });

  it('every var() used without a fallback resolves to a defined property', () => {
    const defined = collectDefined(files);
    const used = collectUsedWithoutFallback(files);

    const undefinedTokens = [...used.entries()]
      .filter(([token]) => !defined.has(token))
      .map(([token, sites]) => `${token} — used in ${[...new Set(sites)].join(', ')}`);

    expect(undefinedTokens).toEqual([]);
  });
});
