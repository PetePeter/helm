/**
 * usePromptApplyFlow — the shared prompt-template apply path.
 *
 * Verifies: picking a template opens the editor PREFILLED with its body and the
 * node pre-selected; sending routes through deliverPromptSequence (never a
 * direct PTY write); a missing/failed body still opens the editor (empty).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockShowPromptTree, mockGetCb, mockHidePromptTree, mockShowEditorPopup, mockGetNode, mockDeliver } = vi.hoisted(() => ({
  mockShowPromptTree: vi.fn(),
  mockGetCb: vi.fn(),
  mockHidePromptTree: vi.fn(),
  mockShowEditorPopup: vi.fn().mockResolvedValue(undefined),
  mockGetNode: vi.fn(),
  mockDeliver: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../renderer/stores/modal-bridge.js', () => ({
  showPromptTree: mockShowPromptTree,
  getPromptTreeCallback: mockGetCb,
  hidePromptTree: mockHidePromptTree,
}));
vi.mock('../../renderer/editor/editor-popup.js', () => ({ showEditorPopup: mockShowEditorPopup }));
vi.mock('../../renderer/ipc/clients.js', () => ({ promptTemplatesClient: { promptTemplateGetNode: mockGetNode } }));
vi.mock('../../renderer/sequence-delivery.js', () => ({ deliverPromptSequence: mockDeliver }));

import { usePromptApplyFlow } from '../../renderer/composables/usePromptApplyFlow.js';

describe('usePromptApplyFlow', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens the editor prefilled with the picked template body + node selected', async () => {
    mockGetNode.mockResolvedValue({ id: 't1', name: 'T1', kind: 'template', body: 'hello {Enter}' });
    const { openEditorForTemplate } = usePromptApplyFlow(() => 'sess-1');

    await openEditorForTemplate('t1');

    expect(mockGetNode).toHaveBeenCalledWith('t1');
    expect(mockShowEditorPopup).toHaveBeenCalledTimes(1);
    const [, initialText, selectNodeId, hasPrefill] = mockShowEditorPopup.mock.calls[0];
    expect(initialText).toBe('hello {Enter}');
    expect(selectNodeId).toBe('t1');
    // Apply flow always supplies an explicit prefill (overrides saved draft).
    expect(hasPrefill).toBe(true);
  });

  it('Ctrl+Enter (editor onSend) routes through deliverPromptSequence — never direct', async () => {
    mockGetNode.mockResolvedValue({ id: 't1', body: 'body' });
    const { openEditorForTemplate } = usePromptApplyFlow(() => 'sess-1');
    await openEditorForTemplate('t1');

    const onSend = mockShowEditorPopup.mock.calls[0][0] as (t: string) => void;
    onSend('body and more {Send}');

    expect(mockDeliver).toHaveBeenCalledWith('sess-1', 'body and more {Send}');
  });

  it('does not deliver when there is no active session', async () => {
    mockGetNode.mockResolvedValue({ id: 't1', body: 'body' });
    const { openEditorForTemplate } = usePromptApplyFlow(() => null);
    await openEditorForTemplate('t1');

    (mockShowEditorPopup.mock.calls[0][0] as (t: string) => void)('x');
    expect(mockDeliver).not.toHaveBeenCalled();
  });

  it('still opens the editor (empty) when the body lookup fails', async () => {
    mockGetNode.mockRejectedValue(new Error('ipc down'));
    const { openEditorForTemplate } = usePromptApplyFlow(() => 'sess-1');
    await openEditorForTemplate('t1');

    expect(mockShowEditorPopup).toHaveBeenCalledTimes(1);
    expect(mockShowEditorPopup.mock.calls[0][1]).toBe('');
    // Empty-on-failure is still an explicit prefill, so it overrides any draft.
    expect(mockShowEditorPopup.mock.calls[0][3]).toBe(true);
  });

  it('openPromptPicker registers a callback that opens the editor for the pick', async () => {
    mockGetNode.mockResolvedValue({ id: 't9', body: 'nine' });
    const { openPromptPicker } = usePromptApplyFlow(() => 'sess-1');
    await openPromptPicker();

    expect(mockShowPromptTree).toHaveBeenCalledTimes(1);
    const onSelect = mockShowPromptTree.mock.calls[0][0] as (id: string) => void;
    await onSelect('t9');

    expect(mockShowEditorPopup).toHaveBeenCalledTimes(1);
    expect(mockShowEditorPopup.mock.calls[0][1]).toBe('nine');
  });

  it('keeps the session captured when the picker opened through the later edit and send', async () => {
    mockGetNode.mockResolvedValue({ id: 't9', body: 'nine' });
    let activeSessionId = 'initial-session';
    const { openPromptPicker } = usePromptApplyFlow(() => activeSessionId);
    await openPromptPicker('row-session');
    activeSessionId = 'newly-active-session';

    const onSelect = mockShowPromptTree.mock.calls[0][0] as (id: string) => void;
    await onSelect('t9');
    const onSend = mockShowEditorPopup.mock.calls[0][0] as (text: string) => void;
    onSend('prompt');

    expect(mockDeliver).toHaveBeenCalledWith('row-session', 'prompt');
  });

  it('handlePromptTreeSelect fires the registered picker callback then hides', () => {
    const cb = vi.fn();
    mockGetCb.mockReturnValue(cb);
    const { handlePromptTreeSelect } = usePromptApplyFlow(() => 'sess-1');

    handlePromptTreeSelect('t5');

    expect(cb).toHaveBeenCalledWith('t5');
    expect(mockHidePromptTree).toHaveBeenCalledTimes(1);
  });
});
