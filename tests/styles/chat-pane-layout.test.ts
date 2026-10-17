/**
 * Chat pane layout contract. jsdom does not perform layout, so protect the
 * responsive CSS constraints directly instead of asserting pretend pixel sizes.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

const component = readFileSync(join(__dirname, '../../renderer/components/dock/ChatPane.vue'), 'utf8');
const styleContent = component.match(/<style scoped>([\s\S]*?)<\/style>/)?.[1] ?? '';
const stylesheet = postcss.parse(styleContent);

function declaration(selector: string, property: string): string | undefined {
  let value: string | undefined;
  stylesheet.walkRules(rule => {
    if (!rule.selector.split(',').some(item => item.trim() === selector)) return;
    rule.walkDecls(property, decl => { value = decl.value; });
  });
  return value;
}

describe('ChatPane narrow layout', () => {
  it('lets the context, message content, and composer shrink to their dock pane', () => {
    expect(declaration('.chat-pane', 'min-width')).toBe('0');
    expect(declaration('.chat-pane', 'grid-template-columns')).toBe('minmax(0, 1fr)');
    expect(declaration('.chat-pane__conversation', 'min-width')).toBe('0');
    expect(declaration('.chat-pane__conversation', 'grid-template-columns')).toBe('minmax(0, 1fr)');
    expect(declaration('.chat-pane__context', 'min-width')).toBe('0');
    expect(declaration('.chat-pane__context', 'flex-wrap')).toBe('wrap');
    expect(declaration('.chat-pane__context-main', 'min-width')).toBe('0');
    expect(declaration('.chat-pane__context-details', 'min-width')).toBe('0');
    expect(declaration('.chat-pane__context-meta', 'max-width')).toBe('100%');
    expect(declaration('.chat-pane__thread', 'min-width')).toBe('0');
    expect(declaration('.chat-pane__message', 'min-width')).toBe('0');
    expect(declaration('.chat-pane__message', 'box-sizing')).toBe('border-box');
    expect(declaration('.chat-pane__text', 'overflow-wrap')).toBe('anywhere');
    expect(declaration('.chat-pane__composer', 'min-width')).toBe('0');
    expect(declaration('.chat-pane__input', 'min-width')).toBe('0');
  });
});
