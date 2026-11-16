/**
 * Static contracts for the global stylesheet. CSS scoping changes selector
 * specificity and DOM reach, so these ownership rules need a source-level
 * guard in addition to runtime component tests.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import postcss, { type Rule } from 'postcss';

const CSS_PATH = join(__dirname, '../../renderer/styles/main.css');
const CSS = readFileSync(CSS_PATH, 'utf8');
const APP_BUTTON_PATH = join(__dirname, '../../renderer/components/common/AppButton.vue');
const APP_BUTTON = readFileSync(APP_BUTTON_PATH, 'utf8');
const APP_BUTTON_STYLES = APP_BUTTON.match(/<style scoped>([\s\S]*?)<\/style>/)?.[1] ?? '';

const APP_BUTTON_VARIANTS = ['sm', 'primary', 'secondary', 'danger', 'ghost', 'success'];

// This ratchet counts the current non-core top-level selectors. It may only
// decrease as legacy global CSS is migrated into its owning components.
const GLOBAL_SELECTOR_BASELINE = 171;

const CORE_PREFIXES = [
  '.helm-app-shell', '.app-',
  '.panel-left', '.panel-right', '.panel-splitter',
  '.sidebar-header', '.sidebar-logo', '.sidebar-brand', '.sidebar-title',
  '.sidebar-tagline', '.sidebar-actions', '.sidebar-btn',
];

const GLOBAL_PREFIXES = [
  '#app',
  '.helm-app-shell', '.app-',
  '.panel-left', '.panel-right', '.panel-splitter',
  '.sidebar-header', '.sidebar-logo', '.sidebar-brand', '.sidebar-title',
  '.sidebar-tagline', '.sidebar-actions', '.sidebar-btn',
  '.modal',
  // Shared/DOM-bound families that are intentionally global. Their owners are
  // documented in docs/css-architecture.md.
  '.tg-', '.plan-header__chip',
  '.terminal-', '.tab-state-dot', '.xterm', '::-webkit-scrollbar',
  // Legacy DOM bridges and shared settings/session surfaces. These are kept
  // global because their DOM is assembled by imperative helpers or rendered
  // by multiple sibling components; the ownership rationale is documented.
  '.settings-workspace-overlay', '.sessions-screen-section',
  '.status-', '.profile-', '.icon-button', '.sidebar-content',
  '#screen-', '.screen',
  '.jump-key', '.spawn-', '.plans-',
  '.nav-hint', 'kbd', '.empty-state', '.hint', '.focusable',
  '.status-content', '.status-card', '.binding-editor-field',
  '.settings-', '.skill-', '.field-', '.notification-', '.tool-',
  '.preview-line', '.controller-',
  '.tools-',
];

const SHARED_PICKER_CLASSES = new Set([
  'dir-picker-list', 'dir-picker-item', 'dir-picker-item__body', 'dir-picker-item__name',
]);

const COMPONENT_OWNED_PREFIXES = [
  'artifact-', 'binding-action', 'binding-card', 'bindings-', 'dir-picker-item__path',
  'mode-', 'modifier-', 'plan-chip', 'plan-dot', 'recycle-bin-', 'sequence-',
  'settings-empty', 'settings-tool-actions', 'tools-empty',
];

const IMPERATIVE_GLOBAL_CLASSES = new Set([
  'screen', 'screen--active',
  'plans-grid-btn',
]);

function classTokens(selector: string): string[] {
  return [...selector.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((match) => match[1]);
}

function hasGlobalOwner(selector: string): boolean {
  const normalized = selector.replace(/\s+/g, ' ').trim();
  const tokens = classTokens(normalized);
  if (tokens.some((token) => token.startsWith('dock-'))) return false;
  if (tokens.some((token) => token.startsWith('context-menu'))) return false;
  if (tokens.length > 0 && tokens.every((token) => SHARED_PICKER_CLASSES.has(token))) return true;
  if (normalized.split(',').every((item) => {
    const trimmed = item.trim();
    return GLOBAL_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
      || classTokens(trimmed).some((token) => GLOBAL_PREFIXES.some((prefix) => `.${token}`.startsWith(prefix)));
  })) {
    return true;
  }
  return classTokens(selector).some((token) => IMPERATIVE_GLOBAL_CLASSES.has(token));
}

function isAllowedSelector(selector: string): boolean {
  const normalized = selector.replace(/\s+/g, ' ').trim();
  if (/\.session-card\.flash-|\.group-header\.flash-/.test(normalized)) return true;
  const selectors = normalized.split(',').map((item) => item.trim());

  return selectors.every((item) => {
    if (item === '*' || /^(body|button|input|select|textarea)(?::|\[|$)/.test(item)) {
      return true;
    }
    if (item === ':root') return true;
    if (/^#app(?:\b|[ >])/.test(item)) return true;
    return hasGlobalOwner(item);
  });
}

function isCoreSelector(selector: string): boolean {
  const normalized = selector.replace(/\s+/g, ' ').trim();
  if (normalized === '*' || normalized === ':root') return true;
  if (/^(body|button|input|select|textarea)(?::|\[|$)/.test(normalized)) {
    return true;
  }
  if (/^#app(?:\b|[ >])/.test(normalized)) {
    return true;
  }
  return CORE_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    || /^\.modal(?:\b|[-:])/.test(normalized);
}

function exactRuleSelectors(rule: Rule, selector: string): boolean {
  return rule.selector.split(',').some((item) => item.trim() === selector);
}

describe('CSS architecture', () => {
  const root = postcss.parse(CSS);
  // The contract is intentionally about root-level ownership. Nested rules
  // belong to the at-rule that owns them (for example keyframe percentages).
  const rules = root.nodes.filter((node): node is Rule => node.type === 'rule');
  const appButtonRoot = postcss.parse(APP_BUTTON_STYLES);
  const appButtonRules = appButtonRoot.nodes.filter((node): node is Rule => node.type === 'rule');

  it('keeps every stylesheet rule in an owned global layer', () => {
    const disallowed = rules
      .filter((rule) => !isAllowedSelector(rule.selector))
      .map((rule) => `${rule.source?.start.line}: ${rule.selector}`);

    expect(disallowed).toEqual([]);
  });

  it('keeps migrated component styles out of main.css', () => {
    const componentOwned = rules
      .flatMap((rule) => rule.selector.split(',').map((selector) => selector.trim()))
      .filter((selector) => classTokens(selector).some((token) => (
        COMPONENT_OWNED_PREFIXES.some((prefix) => token.startsWith(prefix))
      )));

    expect(componentOwned).toEqual([]);
  });

  it('ratchets non-core top-level global selectors downward', () => {
    const nonCoreSelectors = new Set(
      rules.flatMap((rule) => rule.selector.split(',').map((selector) => selector.trim()))
        .filter((selector) => !isCoreSelector(selector)),
    );

    expect(nonCoreSelectors.size).toBeLessThanOrEqual(GLOBAL_SELECTOR_BASELINE);
  });

  it('keeps legacy button selectors out of main.css', () => {
    const legacyButtonRules = rules.filter((rule) => classTokens(rule.selector).some((token) => (
      token === 'btn' || token.startsWith('btn--')
    )));
    expect(legacyButtonRules).toEqual([]);
  });

  it.each(APP_BUTTON_VARIANTS)('declares .app-button--%s exactly once in AppButton.vue', (variant) => {
    const selector = `.app-button--${variant}`;
    expect(appButtonRules.filter((rule) => exactRuleSelectors(rule, selector))).toHaveLength(1);
  });

  it('does not reintroduce the obsolete .btn--small alias', () => {
    expect(`${CSS}\n${APP_BUTTON}`).not.toMatch(/\.btn--small\b/);
  });

  it('uses the readable accent contrast for primary buttons', () => {
    const primary = appButtonRules.find((rule) => exactRuleSelectors(rule, '.app-button--primary'));
    expect(primary?.toString()).toContain('color: var(--accent-contrast)');
    expect(primary?.toString()).not.toMatch(/color\s*:\s*white\b/i);
  });

  it('defines one shared focus-visible ring on AppButton', () => {
    expect(appButtonRules.filter((rule) => exactRuleSelectors(rule, '.app-button:focus-visible'))).toHaveLength(1);
  });
});
