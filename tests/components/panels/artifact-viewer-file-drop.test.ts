/**
 * ArtifactViewer — dropping/pasting files.
 *
 * Regression: a dropped .md or .txt went down the binary-attachment path
 * (the handler only special-cased image/*, and Chromium reports an empty
 * blob.type for .md), so the user got a metadata card with a dead link
 * instead of their document.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { Artifact } from '../../../src/types/artifact.js';

const artifactList = vi.fn();
const artifactCreateText = vi.fn();
const artifactCreateWithFile = vi.fn();
const artifactOpenAttachment = vi.fn();
const artifactPrepareRender = vi.fn();

vi.mock('../../../renderer/ipc/clients.js', () => ({
  artifactsClient: {
    artifactList: (...a: unknown[]) => artifactList(...a),
    artifactCreateText: (...a: unknown[]) => artifactCreateText(...a),
    artifactCreateWithFile: (...a: unknown[]) => artifactCreateWithFile(...a),
    artifactOpenAttachment: (...a: unknown[]) => artifactOpenAttachment(...a),
    artifactPrepareRender: (...a: unknown[]) => artifactPrepareRender(...a),
    artifactDelete: vi.fn(),
    artifactDeleteAll: vi.fn(),
    artifactExport: vi.fn(),
    artifactOpenExternal: vi.fn(),
    artifactRename: vi.fn(),
    artifactUpdate: vi.fn(),
  },
  systemClient: { systemOpenExternalUrl: vi.fn() },
  eventsClient: { onArtifactChanged: vi.fn(), onArtifactReveal: vi.fn() },
}));

import ArtifactViewer from '../../../renderer/components/panels/ArtifactViewer.vue';
import { useArtifactViewer } from '../../../renderer/composables/useArtifactViewer.js';
import { buildAttachmentHref } from '../../../src/types/artifact-attachment.js';
import { OPEN_URL_MESSAGE } from '../../../renderer/artifacts/build-artifact-document.js';

function makeArtifact(over: Partial<Artifact> = {}): Artifact {
  const now = Date.now();
  return {
    id: 'a1',
    sessionId: 'sess-1',
    title: 'Existing',
    kind: 'markdown',
    versions: [{ version: 1, content: 'body', createdAt: now }],
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

async function mountViewer(list: Artifact[] = []) {
  artifactList.mockResolvedValue(list);
  const viewer = useArtifactViewer();
  await viewer.setActiveSession(null);
  const w = mount(ArtifactViewer, { props: { sessionId: 'sess-1' } });
  await flushPromises();
  return w;
}

/** A DragEvent carrying one file — jsdom has no DataTransfer constructor. */
function dropEventWith(file: File): Event {
  const event = new Event('drop', { bubbles: true }) as Event & { dataTransfer: unknown };
  Object.defineProperty(event, 'dataTransfer', { value: { files: [file], types: ['Files'] } });
  return event;
}

beforeEach(() => {
  vi.clearAllMocks();
  artifactPrepareRender.mockResolvedValue('nonce-1');
  artifactCreateText.mockImplementation(async (_s: string, title: string) => makeArtifact({ title }));
  artifactCreateWithFile.mockResolvedValue({ artifact: makeArtifact(), attachment: { id: 'att-1' } });
  artifactOpenAttachment.mockResolvedValue(true);
});

describe('ArtifactViewer — dropping readable files', () => {
  it('turns a dropped .md into a markdown artifact, not an attachment', async () => {
    const w = await mountViewer();
    // Chromium supplies no type for .md — exactly how the bug arose.
    const file = new File(['# Title\n\nBody'], 'notes.md', { type: '' });

    w.element.dispatchEvent(dropEventWith(file));
    await flushPromises();

    expect(artifactCreateWithFile).not.toHaveBeenCalled();
    expect(artifactCreateText).toHaveBeenCalledWith('sess-1', 'notes.md', '# Title\n\nBody', undefined);
  });

  it('fences a dropped .txt so it stays readable', async () => {
    const w = await mountViewer();

    w.element.dispatchEvent(dropEventWith(new File(['line one'], 'log.txt', { type: 'text/plain' })));
    await flushPromises();

    expect(artifactCreateText).toHaveBeenCalledWith('sess-1', 'log.txt', '```\nline one\n```', undefined);
  });

  it('still stores a real binary as an attachment', async () => {
    const w = await mountViewer();

    w.element.dispatchEvent(dropEventWith(new File(['%PDF-1.4'], 'doc.pdf', { type: 'application/pdf' })));
    await flushPromises();

    expect(artifactCreateText).not.toHaveBeenCalled();
    expect(artifactCreateWithFile).toHaveBeenCalled();
  });
});

describe('ArtifactViewer — drop isolation', () => {
  /**
   * A pane drag is pointer-driven and emits no drop event at all, but a session
   * card drag still does. The panel must let any non-file drop pass through
   * rather than swallow it.
   */
  it('ignores a drop that carries no files and leaves the event unclaimed', async () => {
    const w = await mountViewer();
    const event = new Event('drop', { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
    Object.defineProperty(event, 'dataTransfer', { value: { files: [], types: ['text/plain'] } });

    w.element.dispatchEvent(event);
    await flushPromises();

    expect(event.defaultPrevented).toBe(false);
    expect(artifactCreateText).not.toHaveBeenCalled();
    expect(artifactCreateWithFile).not.toHaveBeenCalled();
  });
});

describe('ArtifactViewer — attachment link', () => {
  it('opens the stored file when the attachment link is clicked', async () => {
    const href = buildAttachmentHref('a1', 'att-1');
    const w = await mountViewer([makeArtifact({ versions: [
      { version: 1, content: `📎 [Open in system viewer](${href})`, createdAt: Date.now() },
    ] })]);

    // The link lives in the isolated frame, which reports the click; jsdom
    // never loads the frame, so stand in for its window and its report.
    const frameWindow = {};
    Object.defineProperty(w.find('iframe.ap-frame').element, 'contentWindow', { value: frameWindow });
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: OPEN_URL_MESSAGE, url: href },
      source: frameWindow as MessageEventSource,
    }));
    await flushPromises();

    expect(artifactOpenAttachment).toHaveBeenCalledWith('a1', 'att-1');
  });
});
