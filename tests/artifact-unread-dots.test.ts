/**
 * Artifact unread dots — verify that reveal events mark only the revealed
 * artifact as unread, preserving existing unread state for other artifacts.
 *
 * Tests the module-singleton reactive state in useArtifactViewer.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the reveal callback so tests can fire it manually.
let capturedRevealCb:
  ((payload: { sessionId: string; artifactId: string }) => Promise<void>) | null = null;

vi.mock('../renderer/ipc/clients.js', () => ({
  configClient: {},
  artifactsClient: {
    artifactList: vi.fn().mockResolvedValue([]),
    artifactDelete: vi.fn(),
    artifactExport: vi.fn().mockResolvedValue(null),
  },
  eventsClient: {
    onArtifactChanged: vi.fn(),
    onArtifactReveal: vi.fn((cb: (payload: { sessionId: string; artifactId: string }) => Promise<void>) => {
      capturedRevealCb = cb;
    }),
  },
}));

// Import AFTER mocks are set up.
const { useArtifactViewer } = await import('../renderer/composables/useArtifactViewer.js');
const { artifactsClient } = await import('../renderer/ipc/clients.js');

describe('artifact unread dots', () => {
  beforeEach(async () => {
    const viewer = useArtifactViewer();
    await viewer.setActiveSession(null);
    capturedRevealCb = null;
    // Reset artifactList mock to empty by default
    artifactsClient.artifactList.mockResolvedValue([]);
  });

  it('select() clears the unread dot for the clicked artifact', async () => {
    const viewer = useArtifactViewer();
    viewer.unread.value = new Set(['a1', 'a2']);
    viewer.select('a1');
    expect(viewer.unread.value.has('a1')).toBe(false);
    expect(viewer.unread.value.has('a2')).toBe(true);
  });

  it('reveal marks only the revealed artifact as unread, preserving others', async () => {
    const viewer = useArtifactViewer();
    await viewer.setActiveSession('sess-1');
    viewer.ensureSubscribed();

    // Simulate 3 artifacts existing
    artifactsClient.artifactList.mockResolvedValue([
      { id: 'a1', title: 'One', kind: 'markdown', versions: [], createdAt: 1, updatedAt: 1, sessionId: 'sess-1' },
      { id: 'a2', title: 'Two', kind: 'html', versions: [], createdAt: 2, updatedAt: 2, sessionId: 'sess-1' },
      { id: 'a3', title: 'Three', kind: 'markdown', versions: [], createdAt: 3, updatedAt: 3, sessionId: 'sess-1' },
    ]);

    // Pre-set a2 as unread (from a previous update)
    viewer.unread.value = new Set(['a2']);

    // Fire reveal for a1 (simulating artifact_update)
    expect(capturedRevealCb).not.toBeNull();
    await capturedRevealCb!({ sessionId: 'sess-1', artifactId: 'a1' });

    // a1 should be unread (just revealed/updated)
    expect(viewer.unread.value.has('a1')).toBe(true);
    // a2 should STILL be unread (preserved)
    expect(viewer.unread.value.has('a2')).toBe(true);
    // a3 should NOT be unread (was never marked)
    expect(viewer.unread.value.has('a3')).toBe(false);
    // a1 should be selected
    expect(viewer.selectedId.value).toBe('a1');
  });
});
