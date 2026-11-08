import type { PlanAttachmentManager } from '../../src/session/plan-attachment-manager.js';

/** Explicit inert dependency for tests that do not exercise plan attachments. */
export function unusedPlanAttachmentManager(): PlanAttachmentManager {
  return {
    list: () => [],
    hasAnyForPlanIds: () => false,
    add: () => { throw new Error('Plan attachments are not configured in this test'); },
    delete: () => false,
    deletePlanAttachments: () => {},
    getToTempFile: () => { throw new Error('Plan attachments are not configured in this test'); },
  } as unknown as PlanAttachmentManager;
}
