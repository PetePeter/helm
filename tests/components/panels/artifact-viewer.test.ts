/**
 * ArtifactViewer component tests — exercise real selection, version switching,
 * and delete wiring against the (mocked) artifacts IPC client.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { Artifact } from '../../../src/types/artifact.js';

// --- Mock the IPC clients the composable talks to ---------------------------
const artifactList = vi.fn();
const artifactDelete = vi.fn().mockResolvedValue(true);
const artifactDeleteAll = vi.fn().mockResolvedValue(true);
const artifactExport = vi.fn().mockResolvedValue('/tmp/out.md');
const artifactOpenExternal = vi.fn().mockResolvedValue({ success: true, path: '/tmp/a.md' });
const artifactPrepareRender = vi.fn().mockResolvedValue('nonce-1');
const artifactCreateText = vi.fn();
const artifactCreateWithFile = vi.fn();
const artifactSetIntent = vi.fn();
const systemOpenExternalUrl = vi.fn().mockResolvedValue(true);

vi.mock('../../../renderer/ipc/clients.js', () => ({
  artifactsClient: {
    artifactList: (...a: unknown[]) => artifactList(...a),
    artifactDelete: (...a: unknown[]) => artifactDelete(...a),
    artifactDeleteAll: (...a: unknown[]) => artifactDeleteAll(...a),
    artifactExport: (...a: unknown[]) => artifactExport(...a),
    artifactOpenExternal: (...a: unknown[]) => artifactOpenExternal(...a),
    artifactPrepareRender: (...a: unknown[]) => artifactPrepareRender(...a),
    artifactCreateText: (...a: unknown[]) => artifactCreateText(...a),
    artifactCreateWithFile: (...a: unknown[]) => artifactCreateWithFile(...a),
    artifactSetIntent: (...a: unknown[]) => artifactSetIntent(...a),
  },
  systemClient: {
    systemOpenExternalUrl: (...a: unknown[]) => systemOpenExternalUrl(...a),
  },
  // No-op event subscriptions — return undefined (composable guards with ?.).
  eventsClient: {
    onArtifactChanged: vi.fn(),
    onArtifactReveal: vi.fn(),
  },
}));

import ArtifactViewer from '../../../renderer/components/panels/ArtifactViewer.vue';
import { useArtifactViewer } from '../../../renderer/composables/useArtifactViewer.js';

const originalClipboard = navigator.clipboard;

afterEach(() => {
  Object.assign(navigator, { clipboard: originalClipboard });
});

function makeArtifact(over: Partial<Artifact> = {}): Artifact {
  const now = Date.now();
  return {
    id: 'a1',
    sessionId: 'sess-1',
    title: 'Auth Flow Audit',
    kind: 'markdown',
    versions: [
      { version: 1, content: '# v1 body', createdAt: now - 2000 },
      { version: 2, content: '# v2 body', createdAt: now - 1000 },
      { version: 3, content: '## Latest\n\nNewest content', createdAt: now },
    ],
    createdAt: now - 2000,
    updatedAt: now,
    ...over,
  };
}

async function mountWith(list: Artifact[]) {
  artifactList.mockResolvedValue(list);
  const viewer = useArtifactViewer();
  // Force a clean session binding so module-singleton state resets between tests.
  await viewer.setActiveSession(null);
  const w = mount(ArtifactViewer, { props: { sessionId: 'sess-1' } });
  await flushPromises();
  return { w, viewer };
}

beforeEach(() => {
  vi.clearAllMocks();
  artifactDelete.mockResolvedValue(true);
  artifactDeleteAll.mockResolvedValue(true);
  artifactExport.mockResolvedValue('/tmp/out.md');
  artifactOpenExternal.mockResolvedValue({ success: true, path: '/tmp/a.md' });
  artifactPrepareRender.mockResolvedValue('nonce-1');
  artifactCreateText.mockResolvedValue(makeArtifact({ id: 'text-note' }));
  artifactCreateWithFile.mockResolvedValue({ artifact: makeArtifact({ id: 'pasted-file' }) });
  artifactSetIntent.mockResolvedValue(true);
  systemOpenExternalUrl.mockResolvedValue(true);
});

describe('ArtifactViewer — html vs markdown render path', () => {
  const htmlArtifact = () => makeArtifact({
    kind: 'html',
    versions: [{ version: 1, content: '<style>p{color:red}</style><p>styled</p>', createdAt: Date.now() }],
  });

  it('renders an HTML artifact in a sandboxed frame, not inline', async () => {
    const { w } = await mountWith([htmlArtifact()]);

    const frame = w.find('iframe.ap-frame');
    expect(frame.exists()).toBe(true);
    expect(frame.attributes('sandbox')).toBe('allow-scripts');
    expect(frame.attributes('src')).toContain('helm-artifact://');
    expect(w.find('.ap-doc').exists()).toBe(false);
  });

  it('leaves the markdown path rendering inline', async () => {
    const { w } = await mountWith([makeArtifact()]);

    expect(w.find('.ap-doc').exists()).toBe(true);
    expect(w.find('iframe.ap-frame').exists()).toBe(false);
    expect(artifactPrepareRender).not.toHaveBeenCalled();
  });
});

describe('ArtifactViewer — artifact frame link bridge', () => {
  // Each mount registers a window message listener, so leaked mounts would
  // answer every dispatch and make call counts meaningless.
  const mounted: Array<{ unmount: () => void }> = [];
  afterEach(() => {
    while (mounted.length) mounted.pop()!.unmount();
  });

  /**
   * jsdom never loads the frame, so its contentWindow is null — which would
   * make the identity gate vacuously true. Stub a distinct window per frame so
   * the check under test is the real one.
   */
  async function mountHtml(): Promise<{ w: ReturnType<typeof mount>; frameWindow: object }> {
    const { w } = await mountWith([makeArtifact({
      kind: 'html',
      versions: [{ version: 1, content: '<a href="https://example.com">go</a>', createdAt: Date.now() }],
    })]);
    mounted.push(w);
    const frameWindow = {};
    Object.defineProperty(w.find('iframe.ap-frame').element, 'contentWindow', { value: frameWindow });
    return { w, frameWindow };
  }

  function post(source: unknown, url: string): void {
    window.dispatchEvent(new MessageEvent('message', {
      source: source as MessageEventSource,
      data: { type: 'helm-artifact-open-url', url },
    }));
  }

  it('opens an https link externally, once', async () => {
    const { frameWindow } = await mountHtml();
    post(frameWindow, 'https://example.com/docs');
    expect(systemOpenExternalUrl).toHaveBeenCalledTimes(1);
    expect(systemOpenExternalUrl).toHaveBeenCalledWith('https://example.com/docs');
  });

  it('drops a javascript: url', async () => {
    const { frameWindow } = await mountHtml();
    post(frameWindow, 'javascript:alert(1)');
    expect(systemOpenExternalUrl).not.toHaveBeenCalled();
  });

  // The frame has an opaque origin, so event.origin is the useless string
  // "null" — sender identity is the only gate that actually holds.
  it('drops a message from a window that is not the artifact frame', async () => {
    await mountHtml();
    post(window, 'https://evil.example');
    expect(systemOpenExternalUrl).not.toHaveBeenCalled();
  });
});

describe('ArtifactViewer', () => {
  it('creates Normal artifacts by default', async () => {
    const { w } = await mountWith([]);
    await w.find('.ap-btn-new').trigger('click');
    await w.findAll('.dropdown-item')[0].trigger('click');
    await w.find('.ap-create-title-input').setValue('Note');
    await w.find('.ap-create-body').setValue('Body');
    await w.find('.ap-btn--primary').trigger('click');
    await flushPromises();

    expect(artifactCreateText).toHaveBeenCalledWith('sess-1', 'Note', 'Body', undefined);
  });

  it('creates a manifesto text artifact when selected, with Normal as the default', async () => {
    artifactCreateText.mockResolvedValue(makeArtifact({ id: 'manifesto-note', intent: 'manifesto' }));
    const { w } = await mountWith([]);

    expect((w.find('.ap-new-intent').element as HTMLSelectElement).value).toBe('normal');
    await w.find('.ap-new-intent').setValue('manifesto');
    await w.find('.ap-btn-new').trigger('click');
    await w.findAll('.dropdown-item')[0].trigger('click');
    await w.find('.ap-create-title-input').setValue('Rules');
    await w.find('.ap-create-body').setValue('Keep this');
    await w.find('.ap-btn--primary').trigger('click');
    await flushPromises();

    expect(artifactCreateText).toHaveBeenCalledWith('sess-1', 'Rules', 'Keep this', undefined, 'manifesto');
  });

  it('shows a Manifesto badge in the artifact list and detail header', async () => {
    const { w } = await mountWith([makeArtifact({ intent: 'manifesto' })]);

    expect(w.findAll('.ap-intent-badge')).toHaveLength(2);
    expect(w.findAll('.ap-intent-badge').every(badge => badge.text() === 'Manifesto')).toBe(true);
  });

  it('creates and selects a distinct artifact for each pasted text note', async () => {
    const notes: Artifact[] = [];
    let nextId = 1;
    artifactCreateText.mockImplementation(async (_sessionId: string, title: string, content: string) => {
      const artifact = makeArtifact({
        id: `text-${nextId++}`,
        title,
        versions: [{ version: 1, content, createdAt: Date.now() }],
      });
      notes.unshift(artifact);
      return artifact;
    });
    Object.assign(navigator, {
      clipboard: {
        read: vi.fn().mockResolvedValue([{
          types: ['text/plain'],
          getType: async () => new Blob(['first\nline'], { type: 'text/plain' }),
        }]),
      },
    });

    const { w, viewer } = await mountWith([]);
    artifactList.mockImplementation(async () => [...notes]);
    for (let i = 0; i < 2; i++) {
      await w.find('.ap-btn-new').trigger('click');
      await w.findAll('.dropdown-item')[1].trigger('click');
      await flushPromises();
      await w.find('.ap-btn--primary').trigger('click');
      await flushPromises();
    }

    expect(artifactCreateText).toHaveBeenCalledTimes(2);
    expect(notes).toHaveLength(2);
    expect(viewer.selectedId.value).toBe('text-2');
    expect(w.findAll('.ap-item')).toHaveLength(2);
  });

  it('pastes an arbitrary clipboard file through the attachment IPC path', async () => {
    const { w } = await mountWith([makeArtifact()]);
    const file = new File([new Uint8Array([0, 1, 255])], 'capture.dat', {
      type: 'application/octet-stream',
    });

    await w.find('.artifact-panel').trigger('paste', {
      clipboardData: {
        items: [{ kind: 'file', getAsFile: () => file }],
      },
    });
    await flushPromises();

    expect(artifactCreateWithFile).toHaveBeenCalledWith('sess-1', {
      filename: 'capture.dat',
      contentBase64: 'AAH/',
      contentType: 'application/octet-stream',
    });
  });

  it('imports a file with the selected manifesto intent', async () => {
    const { w } = await mountWith([]);
    await w.find('.ap-new-intent').setValue('manifesto');
    const file = new File([new Uint8Array([0, 1, 255])], 'capture.dat', {
      type: 'application/octet-stream',
    });

    await w.find('.artifact-panel').trigger('paste', {
      clipboardData: { items: [{ kind: 'file', getAsFile: () => file }] },
    });
    await flushPromises();

    expect(artifactCreateWithFile).toHaveBeenCalledWith('sess-1', {
      filename: 'capture.dat',
      contentBase64: 'AAH/',
      contentType: 'application/octet-stream',
      intent: 'manifesto',
    });
  });

  it('lists artifacts and auto-selects the newest, rendering its latest version', async () => {
    const b = makeArtifact({ id: 'b1', title: 'Perf Benchmark', updatedAt: Date.now() - 5000, createdAt: Date.now() - 5000 });
    const { w } = await mountWith([makeArtifact(), b]);

    const items = w.findAll('.ap-item');
    expect(items).toHaveLength(2);

    // Newest (a1, updatedAt = now) is auto-selected.
    expect(w.find('.ap-item--active .ap-it-title').text()).toBe('Auth Flow Audit');
    // Latest version (v3) markdown is rendered and sanitized into the doc.
    expect(w.find('.ap-doc').html()).toContain('Newest content');
    // No "viewing older" banner when on latest.
    expect(w.find('.ap-v-old').exists()).toBe(false);
  });

  it('switches to an older version and shows the jump-to-latest banner', async () => {
    const { w } = await mountWith([makeArtifact()]);

    // Step back one version (v3 -> v2).
    const olderBtn = w.findAll('.ap-v-step').find((b) => b.attributes('title') === 'Older');
    await olderBtn!.trigger('click');
    await flushPromises();

    expect(w.find('.ap-v-old').exists()).toBe(true);
    expect(w.find('.ap-doc').html()).toContain('v2 body');

    // Jump to latest clears the banner and restores v3.
    await w.find('.ap-restore').trigger('click');
    await flushPromises();
    expect(w.find('.ap-v-old').exists()).toBe(false);
    expect(w.find('.ap-doc').html()).toContain('Newest content');
  });

  function footBtn(w: ReturnType<typeof mount>, text: string) {
    return w.findAll('.ap-btn').find((b) => b.text().includes(text));
  }

  it('deletes the selected artifact from the footer after confirm', async () => {
    const { w } = await mountWith([makeArtifact()]);

    // First click arms the inline confirm — nothing is deleted yet.
    await footBtn(w, 'Delete')!.trigger('click');
    await flushPromises();
    expect(artifactDelete).not.toHaveBeenCalled();
    expect(w.text()).toContain('Delete?');

    // Confirm actually deletes; the list is empty on reload.
    artifactList.mockResolvedValue([]);
    await footBtn(w, 'Yes')!.trigger('click');
    await flushPromises();

    expect(artifactDelete).toHaveBeenCalledWith('a1');
    expect(w.findAll('.ap-item')).toHaveLength(0);
    expect(w.find('.ap-detail-empty').exists()).toBe(true);
  });

  it('opens the version currently on screen, not just the latest', async () => {
    const { w } = await mountWith([makeArtifact()]);

    // Pin an older version (v3 -> v2), then open externally.
    const olderBtn = w.findAll('.ap-v-step').find((b) => b.attributes('title') === 'Older');
    await olderBtn!.trigger('click');
    await flushPromises();

    await footBtn(w, 'Open externally')!.trigger('click');
    await flushPromises();

    expect(artifactOpenExternal).toHaveBeenCalledWith('a1', 2);
  });

  it('surfaces the failure reason in the footer when the OS has no handler', async () => {
    artifactOpenExternal.mockResolvedValue({ success: false, error: 'No application is associated with .md' });
    const { w } = await mountWith([makeArtifact()]);

    await footBtn(w, 'Open externally')!.trigger('click');
    await flushPromises();

    expect(w.text()).toContain('No application is associated with .md');
  });

  it('copies a Helm reference for the selected artifact', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { w } = await mountWith([makeArtifact({ title: 'Auth Flow Audit' })]);

    await footBtn(w, 'Copy reference')!.trigger('click');
    await flushPromises();

    expect(writeText).toHaveBeenCalledWith('helm artifact: "Auth Flow Audit" id=a1');
  });

  it('filters the rail by search query', async () => {
    const b = makeArtifact({ id: 'b1', title: 'Perf Benchmark', kind: 'html' });
    const { w } = await mountWith([makeArtifact(), b]);

    await w.find('.ap-search input').setValue('perf');
    await flushPromises();

    const titles = w.findAll('.ap-it-title').map((t) => t.text());
    expect(titles).toEqual(['Perf Benchmark']);
  });

  it('has no rail collapse control — collapsing a pane is the dock\'s job', async () => {
    const { w } = await mountWith([makeArtifact()]);

    expect(w.find('.ap-rail-collapse').exists()).toBe(false);
    expect(w.find('.ap-rail--collapsed').exists()).toBe(false);
    // The rail contents are unconditional, so the list is always reachable.
    expect(w.find('.ap-rail-inner').isVisible()).toBe(true);
    expect(localStorage.getItem('helm:artifact-rail-collapsed')).toBeNull();
  });

  it('shows an empty state when the search query matches no artifacts', async () => {
    const { w } = await mountWith([makeArtifact()]);

    await w.find('.ap-search input').setValue('does-not-exist');
    await flushPromises();

    expect(w.find('.ap-rail-list .empty-state').text()).toContain('No artifacts match your search');
  });

  it('emits pop-out from the header without a duplicate panel-close action', async () => {
    const { w } = await mountWith([makeArtifact()]);

    await w.findAll('.ap-ico').find((b) => b.attributes('title')?.includes('Pop out'))!.trigger('click');

    expect(w.find('.ap-ico[title="Close panel"]').exists()).toBe(false);
    expect(w.emitted('close')).toBeUndefined();
    expect(w.emitted('pop-out')).toHaveLength(1);
  });
});
