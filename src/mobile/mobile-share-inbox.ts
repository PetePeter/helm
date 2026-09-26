/**
 * mobile-share-inbox — where a file shared from the phone's share sheet lands.
 *
 * The bytes are written under the per-user temp dir (`<appData>/Helm/tmp/inbox`,
 * never the repo tree — docs/config-boundary.md) and the picked session gets a
 * DRAFT naming the absolute path. Nothing is sent to the CLI: the user decides
 * when the draft goes, the same as any other draft (docs/drafts.md).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DraftManager } from '../session/draft-manager.js';
import type { ShareReceipt, ShareSink } from './mobile-artifact-upload.js';

/** The phone's filename is untrusted: no directories, no reserved characters. */
export function safeShareFilename(filename: string): string {
  const leaf = basename(filename.replace(/\\/g, '/'));
  const cleaned = leaf.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '');
  return cleaned.slice(0, 120) || 'shared-file';
}

export class MobileShareInbox implements ShareSink {
  constructor(
    private readonly dir: string,
    private readonly drafts: Pick<DraftManager, 'create'>,
  ) {}

  receive(sessionId: string, filename: string, content: Buffer): ShareReceipt {
    const name = safeShareFilename(filename);
    // A per-share folder keeps the user's filename intact and collision-free.
    const folder = join(this.dir, randomUUID());
    mkdirSync(folder, { recursive: true });
    const path = join(folder, name);
    writeFileSync(path, content);
    const draft = this.drafts.create(sessionId, `Shared: ${name}`, `Attached: ${name} at ${path}`);
    return { sessionId, path, draftId: draft.id };
  }
}
