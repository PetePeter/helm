/**
 * Renderer utils — shared helper function tests.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getCliDisplayName, getSequenceSyntaxHelpText, navigateFocus } from '../renderer/utils.js';
import { state } from '../renderer/state.js';

describe('navigateFocus', () => {
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    document.body.innerHTML = `
      <button class="focusable" id="first">First</button>
      <button class="focusable" id="second">Second</button>
      <button class="focusable" id="third">Third</button>
    `;
    Element.prototype.scrollIntoView = scrollIntoView;
    scrollIntoView.mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('moves focus to the next element and scrolls it into view', () => {
    (document.getElementById('first') as HTMLButtonElement).focus();

    navigateFocus(1);

    expect(document.activeElement).toBe(document.getElementById('second'));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
  });

  it('wraps focus and keeps the wrapped element in view', () => {
    (document.getElementById('first') as HTMLButtonElement).focus();

    navigateFocus(-1);

    expect(document.activeElement).toBe(document.getElementById('third'));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
  });
});

const CLAUDE_ID = '5e1f5c1e-6c2f-4d54-9a3f-1c7d9b2a4e10';
const COPILOT_ID = 'b2c3d4e5-1111-4222-8333-444455556666';

describe('getCliDisplayName', () => {
  beforeEach(() => {
    state.cliToolsCache = {};
  });

  it('returns the record displayName for a uuid reference', () => {
    state.cliToolsCache[CLAUDE_ID] = { id: CLAUDE_ID, displayName: 'Claude', name: 'Claude' };
    expect(getCliDisplayName(CLAUDE_ID)).toBe('Claude');
  });

  it('resolves a display-name reference case-insensitively', () => {
    state.cliToolsCache[COPILOT_ID] = { id: COPILOT_ID, displayName: 'Copilot', name: 'Copilot' };
    expect(getCliDisplayName('  copilot ')).toBe('Copilot');
  });

  it('never prints a raw uuid when the reference does not resolve', () => {
    const label = getCliDisplayName(CLAUDE_ID);
    expect(label).not.toContain(CLAUDE_ID);
    expect(label).toBe('Unknown CLI');
  });

  it('echoes a non-uuid reference verbatim when nothing resolves', () => {
    expect(getCliDisplayName('my-custom-cli')).toBe('my-custom-cli');
  });
});

