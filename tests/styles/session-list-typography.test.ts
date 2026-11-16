/**
 * Session-list typography contract. jsdom does not compute stylesheet values,
 * so this protects the shared token ownership in the source CSS instead.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SESSION_CARD_CSS = readFileSync(join(__dirname, '../../renderer/components/sidebar/SessionCard.vue'), 'utf8');
const NOTIFICATION_CSS = readFileSync(join(__dirname, '../../renderer/components/sidebar/NotificationCarousel.vue'), 'utf8');
const TOAST_CSS = readFileSync(join(__dirname, '../../renderer/components/ToastNotification.vue'), 'utf8');

describe('session-list typography', () => {
  it('uses the medium token for the session name and working plan', () => {
    expect(SESSION_CARD_CSS).toMatch(/\.session-card \.session-name \{[^}]*font-size: var\(--font-size-md\)/s);
    expect(SESSION_CARD_CSS).toMatch(/\.session-working-plan \{[^}]*font-size: var\(--font-size-md\)/s);
    expect(SESSION_CARD_CSS).toMatch(/\.session-card \.session-meta \{[^}]*font-size: var\(--font-size-sm\)/s);
  });

  it('uses the medium token for readable notification text', () => {
    expect(NOTIFICATION_CSS).toMatch(/\.carousel-title \{[^}]*font-size: var\(--font-size-md\)/s);
    expect(NOTIFICATION_CSS).toMatch(/\.carousel-text \{[^}]*font-size: var\(--font-size-md\)/s);
    expect(TOAST_CSS).toMatch(/\.toast \{[^}]*font-size: var\(--font-size-md\)/s);
  });
});
