/**
 * ArtifactViewer — in-situ editing and the blank-frame escape hatch.
 *
 * Editing autosaves into a draft while the user types, saves a NEW version
 * through artifact:update, and is offered on the latest version only. HTML artifacts that never report themselves ready get a
 * prominent Open-externally card where the content should have been.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { Artifact } from '../../../src/types/artifact.js';

const artifactList = vi.fn();
const artifactUpdate = vi.fn();
const artifactSetDraft = vi.fn();
const artifactDiscardDraft = vi.fn();
const artifactSetIntent = vi.fn();
const artifactRename = vi.fn();
const artifactOpenExternal = vi.fn();
const artifactPrepareRender = vi.fn();

vi.mock('../../../renderer/ipc/clients.js', () => ({
  artifactsClient: {
    artifactList: (...a: unknown[]) => artifactList(...a),
    artifactUpdate: (...a: unknown[]) => artifactUpdate(...a),
    artifactSetDraft: (...a: unknown[]) => artifactSetDraft(...a),
    artifactDiscardDraft: (...a: unknown[]) => artifactDiscardDraft(...a),
    artifactSetIntent: (...a: unknown[]) => artifactSetIntent(...a),
    artifactRename: (...a: unknown[]) => artifactRename(...a),
    artifactOpenExternal: (...a: unknown[]) => artifactOpenExternal(...a),
    artifactPrepareRender: (...a: unknown[]) => artifactPrepareRender(...a),
    artifactDelete: vi.fn(),
    artifactDeleteAll: vi.fn(),
    artifactExport: vi.fn(),
    artifactCreateText: vi.fn(),
    artifactCreateWithFile: vi.fn(),
  },
  systemClient: { systemOpenExternalUrl: vi.fn() },
  eventsClient: { onArtifactChanged: vi.fn(), onArtifactReveal: vi.fn() },
}));

import ArtifactViewer from '../../../renderer/components/panels/ArtifactViewer.vue';
import { useArtifactViewer } from '../../../renderer/composables/useArtifactViewer.js';
import { READY_MESSAGE } from '../../../renderer/artifacts/build-artifact-document.js';

const FRAME_READY_TIMEOUT_MS = 1500;

function makeArtifact(over: Partial<Artifact> = {}): Artifact {
  const now = Date.now();
  return {
    id: 'a1',
    sessionId: 'sess-1',
    title: 'Auth Flow Audit',
    kind: 'markdown',
    versions: [
      { version: 1, content: '# v1 body', createdAt: now - 1000 },
      { version: 2, content: '# v2 body', createdAt: now },
    ],
    createdAt: now - 1000,
    updatedAt: now,
    ...over,
  };
}

function htmlArtifact(over: Partial<Artifact> = {}): Artifact {
  return makeArtifact({
    kind: 'html',
    versions: [{ version: 1, content: '<p>styled</p>', createdAt: Date.now() }],
    ...over,
  });
}

async function mountWith(list: Artifact[]) {
  artifactList.mockResolvedValue(list);
  const viewer = useArtifactViewer();
  // Reset the module-singleton state between tests.
  await viewer.setActiveSession(null);
  const w = mount(ArtifactViewer, { props: { sessionId: 'sess-1' } });
  await flushPromises();
  return { w, viewer };
}

/** The footer button whose label starts with the given text. */
function footButton(w: ReturnType<typeof mount>, label: string) {
  const btn = w.findAll('.ap-foot .ap-btn').find(b => b.text().includes(label));
  if (!btn) throw new Error(`footer button "${label}" not found`);
  return btn;
}

beforeEach(() => {
  vi.clearAllMocks();
  artifactPrepareRender.mockResolvedValue('nonce-1');
  artifactOpenExternal.mockResolvedValue({ success: true, path: '/tmp/a.html' });
  artifactRename.mockResolvedValue(true);
  artifactUpdate.mockImplementation(async (_id: string, content: string) =>
    makeArtifact({ versions: [{ version: 3, content, createdAt: Date.now() }] }));
  artifactSetIntent.mockResolvedValue(true);
  artifactSetDraft.mockResolvedValue(true);
  artifactDiscardDraft.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ArtifactViewer — in-situ edit', () => {
  it('changes intent through metadata without appending a content version', async () => {
    const { w } = await mountWith([makeArtifact()]);

    await w.find('.ap-selected-intent').setValue('manifesto');
    await flushPromises();

    expect(artifactSetIntent).toHaveBeenCalledWith('a1', 'manifesto');
    expect(artifactUpdate).not.toHaveBeenCalled();
  });

  it('opens the editor with the raw source of the shown version', async () => {
    const { w } = await mountWith([makeArtifact()]);

    await footButton(w, 'Edit').trigger('click');

    expect((w.find('textarea.ap-create-body').element as HTMLTextAreaElement).value).toBe('# v2 body');
  });

  it('saves an edit as a new version and leaves edit mode', async () => {
    const { w } = await mountWith([makeArtifact()]);
    await footButton(w, 'Edit').trigger('click');

    await w.find('textarea.ap-create-body').setValue('# edited body');
    await footButton(w, 'Save').trigger('click');
    await flushPromises();

    expect(artifactUpdate).toHaveBeenCalledWith('a1', '# edited body');
    expect(w.find('textarea.ap-create-body').exists()).toBe(false);
  });

  it('discards the draft on cancel without calling update', async () => {
    const { w } = await mountWith([makeArtifact()]);
    await footButton(w, 'Edit').trigger('click');
    await w.find('textarea.ap-create-body').setValue('# thrown away');

    await footButton(w, 'Cancel').trigger('click');
    await flushPromises();

    expect(artifactUpdate).not.toHaveBeenCalled();
    expect(artifactDiscardDraft).toHaveBeenCalledWith('a1');
    expect(w.find('iframe.ap-frame').exists()).toBe(true);
  });

  describe('draft autosave', () => {
    const AUTOSAVE_MS = 500;
    const editor = (w: ReturnType<typeof mount>) => w.find('textarea.ap-create-body');

    it('autosaves into the draft once typing pauses, and stays in edit mode', async () => {
      const { w } = await mountWith([makeArtifact()]);
      await footButton(w, 'Edit').trigger('click');
      vi.useFakeTimers();

      await editor(w).setValue('# half');
      await vi.advanceTimersByTimeAsync(AUTOSAVE_MS - 1);
      expect(artifactSetDraft).not.toHaveBeenCalled();

      await editor(w).setValue('# half written');
      await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);

      // One save, of the text as it stood when the typing stopped.
      expect(artifactSetDraft).toHaveBeenCalledTimes(1);
      expect(artifactSetDraft).toHaveBeenCalledWith('a1', '# half written');
      expect(artifactUpdate).not.toHaveBeenCalled();
      expect(editor(w).exists()).toBe(true);
      expect(w.find('.ap-foot').text()).toContain('Draft saved');
    });

    // Save commits what is on screen; a stale autosave landing afterwards would
    // resurrect the draft the commit just spent.
    it('Save commits the text on screen and cancels the pending autosave', async () => {
      const { w } = await mountWith([makeArtifact()]);
      await footButton(w, 'Edit').trigger('click');
      vi.useFakeTimers();

      await editor(w).setValue('# final');
      await footButton(w, 'Save').trigger('click');
      await vi.advanceTimersByTimeAsync(AUTOSAVE_MS * 2);

      expect(artifactUpdate).toHaveBeenCalledWith('a1', '# final');
      expect(artifactSetDraft).not.toHaveBeenCalled();
    });

    it('resumes an unsaved draft instead of the committed version', async () => {
      const { w } = await mountWith([makeArtifact({ draft: { content: '# left unfinished', updatedAt: Date.now() } })]);

      expect(w.find('.ap-draft-badge').exists()).toBe(true);
      await footButton(w, 'Resume draft').trigger('click');

      expect((editor(w).element as HTMLTextAreaElement).value).toBe('# left unfinished');
    });

    // Walking away is not Cancel: what was typed must reach the draft even if
    // the pause that triggers an autosave never came.
    it('keeps unsaved typing as a draft when another artifact is selected', async () => {
      const other = makeArtifact({ id: 'b1', title: 'Other', updatedAt: Date.now() - 5000 });
      const { w, viewer } = await mountWith([makeArtifact(), other]);
      await footButton(w, 'Edit').trigger('click');
      await editor(w).setValue('# mid-thought');

      viewer.select('b1');
      await flushPromises();

      expect(artifactSetDraft).toHaveBeenCalledWith('a1', '# mid-thought');
      expect(artifactDiscardDraft).not.toHaveBeenCalled();
      expect(editor(w).exists()).toBe(false);
    });
  });

  it('disables Edit while an older version is on screen', async () => {
    const { w, viewer } = await mountWith([makeArtifact()]);

    viewer.setVersion(1);
    await flushPromises();

    expect(footButton(w, 'Edit').attributes('disabled')).toBeDefined();
  });

  it('offers a rename button beside the title', async () => {
    const { w } = await mountWith([makeArtifact()]);

    await w.find('.ap-rename-btn').trigger('click');

    expect(w.find('input.ap-rename-input').exists()).toBe(true);
  });
});

describe('ArtifactViewer — blank HTML frame fallback', () => {
  /** Post the frame's ready ping exactly as the injected script does. */
  function sendReady(w: ReturnType<typeof mount>): void {
    const frame = w.find('iframe.ap-frame').element as HTMLIFrameElement;
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: READY_MESSAGE },
      source: frame.contentWindow,
    }));
  }

  it('shows no fallback when the frame reports itself ready', async () => {
    vi.useFakeTimers();
    const { w } = await mountWith([htmlArtifact()]);

    sendReady(w);
    vi.advanceTimersByTime(FRAME_READY_TIMEOUT_MS * 2);
    await flushPromises();

    expect(w.find('.ap-frame-fallback').exists()).toBe(false);
  });

  it('shows the fallback card when no ready ping arrives', async () => {
    vi.useFakeTimers();
    const { w } = await mountWith([htmlArtifact()]);

    vi.advanceTimersByTime(FRAME_READY_TIMEOUT_MS);
    await flushPromises();

    expect(w.find('.ap-frame-fallback').exists()).toBe(true);
  });

  it('routes the fallback button through the same open-externally path', async () => {
    vi.useFakeTimers();
    const { w } = await mountWith([htmlArtifact()]);
    vi.advanceTimersByTime(FRAME_READY_TIMEOUT_MS);
    await flushPromises();

    await w.find('.ap-ff-btn').trigger('click');
    await flushPromises();

    expect(artifactOpenExternal).toHaveBeenCalledWith('a1', 1);
  });

  it('clears the fallback when a different artifact is selected', async () => {
    vi.useFakeTimers();
    const other = htmlArtifact({ id: 'a2', title: 'Second' });
    const { w, viewer } = await mountWith([htmlArtifact(), other]);
    vi.advanceTimersByTime(FRAME_READY_TIMEOUT_MS);
    await flushPromises();
    expect(w.find('.ap-frame-fallback').exists()).toBe(true);

    viewer.select('a2');
    await flushPromises();

    expect(w.find('.ap-frame-fallback').exists()).toBe(false);
  });
});
