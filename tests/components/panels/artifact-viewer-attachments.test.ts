/**
 * ArtifactViewer attachment-section tests — the detail pane lists the selected
 * artifact's attachments, Add goes through the picker + add IPC, Delete goes
 * through the delete IPC and reloads.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { Artifact } from '../../../src/types/artifact.js';
import type { ArtifactAttachment } from '../../../src/types/artifact-attachment.js';

// --- Mock the IPC clients the composable talks to ---------------------------
const artifactList = vi.fn();
const artifactPickAndReadFile = vi.fn();
const artifactAttachmentList = vi.fn().mockResolvedValue([]);
const artifactAttachmentAdd = vi.fn();
const artifactAttachmentDelete = vi.fn().mockResolvedValue(true);
const artifactPrepareRender = vi.fn().mockResolvedValue('nonce-1');

vi.mock('../../../renderer/ipc/clients.js', () => ({
  artifactsClient: {
    artifactList: (...a: unknown[]) => artifactList(...a),
    artifactPrepareRender: (...a: unknown[]) => artifactPrepareRender(...a),
    artifactPickAndReadFile: (...a: unknown[]) => artifactPickAndReadFile(...a),
    artifactAttachmentList: (...a: unknown[]) => artifactAttachmentList(...a),
    artifactAttachmentAdd: (...a: unknown[]) => artifactAttachmentAdd(...a),
    artifactAttachmentDelete: (...a: unknown[]) => artifactAttachmentDelete(...a),
  },
  systemClient: { systemOpenExternalUrl: vi.fn().mockResolvedValue(true) },
  eventsClient: { onArtifactChanged: vi.fn(), onArtifactReveal: vi.fn() },
}));

import ArtifactViewer from '../../../renderer/components/panels/ArtifactViewer.vue';
import { useArtifactViewer } from '../../../renderer/composables/useArtifactViewer.js';

function makeArtifact(): Artifact {
  const now = Date.now();
  return {
    id: 'a1',
    sessionId: 'sess-1',
    title: 'Auth Flow Audit',
    kind: 'markdown',
    versions: [{ version: 1, content: '# body', createdAt: now }],
    createdAt: now,
    updatedAt: now,
  };
}

function makeAttachment(id: string, filename: string, sizeBytes: number): ArtifactAttachment {
  return {
    id,
    artifactId: 'a1',
    filename,
    sizeBytes,
    relativePath: `${id}.bin`,
    createdAt: Date.now(),
  };
}

async function mountWith(atts: ArtifactAttachment[]) {
  artifactList.mockResolvedValue([makeArtifact()]);
  artifactAttachmentList.mockResolvedValue(atts);
  const viewer = useArtifactViewer();
  await viewer.setActiveSession(null);
  const w = mount(ArtifactViewer, { props: { sessionId: 'sess-1' } });
  await flushPromises();
  return { w, viewer };
}

beforeEach(() => {
  vi.clearAllMocks();
  artifactPrepareRender.mockResolvedValue('nonce-1');
  artifactAttachmentList.mockResolvedValue([]);
  artifactAttachmentDelete.mockResolvedValue(true);
});

describe('ArtifactViewer — attachments section', () => {
  it('lists the selected artifact\'s attachments with size', async () => {
    const { w } = await mountWith([
      makeAttachment('att-1', 'evidence.png', 2048),
      makeAttachment('att-2', 'report.pdf', 3 * 1024 * 1024),
    ]);

    expect(artifactAttachmentList).toHaveBeenCalledWith('a1');
    const rows = w.findAll('.ap-att__row');
    expect(rows).toHaveLength(2);
    expect(rows[0].find('.ap-att__name').text()).toBe('evidence.png');
    expect(rows[0].find('.ap-att__size').text()).toBe('2 KB');
    expect(rows[1].find('.ap-att__size').text()).toBe('3.0 MB');
  });

  it('shows the empty label when there are none', async () => {
    const { w } = await mountWith([]);
    expect(w.find('.ap-att__empty').text()).toBe('No attachments');
  });

  it('Add picks a file and stores it against the selected artifact', async () => {
    artifactPickAndReadFile.mockResolvedValue({
      filename: 'shot.png',
      contentBase64: Buffer.from('png').toString('base64'),
      contentType: 'image/png',
    });
    artifactAttachmentAdd.mockResolvedValue(makeAttachment('att-new', 'shot.png', 3));
    const { w } = await mountWith([]);

    await w.find('.ap-att__add').trigger('click');
    await flushPromises();

    expect(artifactAttachmentAdd).toHaveBeenCalledWith('a1', {
      filename: 'shot.png',
      contentBase64: 'cG5n',
      contentType: 'image/png',
    });
    // The list is reloaded after the add.
    expect(artifactAttachmentList).toHaveBeenCalledTimes(2);
  });

  it('Add with a cancelled picker adds nothing', async () => {
    artifactPickAndReadFile.mockResolvedValue(null);
    const { w } = await mountWith([]);

    await w.find('.ap-att__add').trigger('click');
    await flushPromises();

    expect(artifactAttachmentAdd).not.toHaveBeenCalled();
    expect(artifactAttachmentList).toHaveBeenCalledTimes(1);
    expect(w.text()).not.toContain('Could not attach file');
  });

  it('Delete removes the attachment and reloads the list', async () => {
    const { w } = await mountWith([makeAttachment('att-1', 'evidence.png', 2048)]);

    const del = w.findAll('.ap-att__row .ap-btn').find(b => b.text() === 'Delete')!;
    await del.trigger('click');
    await flushPromises();

    expect(artifactAttachmentDelete).toHaveBeenCalledWith('a1', 'att-1');
    expect(artifactAttachmentList).toHaveBeenCalledTimes(2);
  });
});
