/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

describe('persisted filter preferences', () => {
  let changed: ((value: { id: string; value: unknown }) => void) | null = null;
  let setPreference: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    changed = null;
    setPreference = vi.fn().mockResolvedValue({ success: true });
    (window as unknown as { helm: unknown }).helm = {
      config: {
        configGetFilterPreference: vi.fn().mockResolvedValue('yes'),
        configSetFilterPreference: setPreference,
        onFilterPreferenceChanged: (listener: typeof changed) => {
          changed = listener;
          return () => { changed = null; };
        },
      },
    };
  });

  afterEach(() => {
    changed = null;
  });

  it('loads and saves values through the registered stable ID', async () => {
    const { registerFilterPreference } = await import('../renderer/stores/filter-preferences.js');
    const preference = registerFilterPreference('todo.done', 'either' as const, value =>
      value === 'yes' || value === 'no' || value === 'either' ? value : 'either',
    );

    await preference.ready;
    expect(preference.value.value).toBe('yes');

    preference.value.value = 'no';
    await nextTick();
    expect(setPreference).toHaveBeenCalledWith('todo.done', 'no');
  });

  it('applies remote updates without writing them back', async () => {
    const { registerFilterPreference } = await import('../renderer/stores/filter-preferences.js');
    const preference = registerFilterPreference('todo.done', 'either' as const, value =>
      value === 'yes' || value === 'no' || value === 'either' ? value : 'either',
    );
    await preference.ready;
    setPreference.mockClear();

    changed?.({ id: 'todo.done', value: 'no' });
    await nextTick();

    expect(preference.value.value).toBe('no');
    expect(setPreference).not.toHaveBeenCalled();
  });
});
