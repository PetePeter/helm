import { describe, expect, it } from 'vitest';
import { ONBOARDING_SETTING_GROUPS } from '../renderer/onboarding-settings-topics';
import { SETTINGS_PAGES } from '../renderer/components/settings/settings-registry';

describe('onboarding settings topics', () => {
  it('links each topic to a registered settings page, including Session List', () => {
    const topics = ONBOARDING_SETTING_GROUPS.flatMap(group => group.topics);
    const registeredIds = new Set(SETTINGS_PAGES.map(page => page.id));

    expect(topics.map(topic => topic.tabId)).toContain('session-list');
    for (const topic of topics) expect(registeredIds.has(topic.tabId)).toBe(true);
  });
});
