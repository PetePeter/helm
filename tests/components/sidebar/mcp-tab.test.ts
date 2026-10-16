/**
 * McpTab component tests.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import McpTab from '../../../renderer/components/settings/pages/McpTab.vue';

describe('McpTab.vue', () => {
  beforeEach(() => {
    // Mock window.gamepadCli for McpCliSetup component
    (window as any).gamepadCli = {
      configGetCliTypes: vi.fn().mockResolvedValue(['codex', 'claude-code', 'copilot-cli', 'opencode']),
      configGetCliTypeEnv: vi.fn().mockResolvedValue([]),
    };
  });

  it('renders copy-paste setup and teardown blocks for supported CLIs', async () => {
    const wrapper = mount(McpTab, {
      props: {
        config: {
          enabled: true,
          port: 47373,
          authToken: 'secret-token',
        },
      },
    });

    // Wait for async operations in McpCliSetup to complete
    await wrapper.vm.$nextTick();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const text = wrapper.text();
    expect(text).toContain('Codex setup');
    expect(text).toContain('Claude Code setup');
    expect(text).toContain('Copilot CLI setup');
    expect(text).toContain('OpenCode setup');

  });

  it('emits token updates while typing so the value is not lost when settings closes before blur', async () => {
    const wrapper = mount(McpTab, {
      props: {
        config: {
          enabled: true,
          port: 47373,
          authToken: '',
        },
      },
    });

    const tokenInput = wrapper.find('input[type="password"]');
    await tokenInput.setValue(' pasted-token ');

    expect(wrapper.emitted('update')).toContainEqual([{ authToken: 'pasted-token' }]);
  });

  it('emits port changes on change as well as blur', async () => {
    const wrapper = mount(McpTab, {
      props: {
        config: {
          enabled: true,
          port: 47373,
          authToken: 'secret-token',
        },
      },
    });

    const portInput = wrapper.find('input[type="number"]');
    await portInput.setValue('48100');
    await portInput.trigger('change');

    expect(wrapper.emitted('update')).toContainEqual([{ port: 48100 }]);
  });
});
