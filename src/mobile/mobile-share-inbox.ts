/**
 * mobile-share-inbox — where a file shared from the phone's share sheet lands.
 *
 * The bytes are written under the per-user temp dir (`<appData>/Helm/tmp/inbox`,
 * never the repo tree — docs/config-boundary.md) and the picked session gets a
 * DRAFT naming the absolute path. Nothing is sent to the CLI: the user decides
 * when the draft goes, the same as any other draft (docs/drafts.md).
 */

import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DraftManager } from '../session/draft-manager.js';
import type { ShareReceipt, ShareSink } from './mobile-artifact-upload.js';
import { MAX_ATTACHMENT_BYTES } from '../session/artifact-attachment-manager.js';
import { getTempDir } from '../utils/app-paths.js';

/** The phone's filename is untrusted: no directories, no reserved characters. */
export function safeShareFilename(filename: string): string {
  const leaf = basename(filename.replace(/\\/g, '/'));
  const cleaned = leaf.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '');
  return cleaned.slice(0, 120) || 'shared-file';
}

/** Resolve a phone-supplied image path only when it is a bounded inbox file. */
export function resolveMobileShareInputPath(candidate: string, inboxDir = join(getTempDir(''), 'inbox')): string {
  let inbox: string;
  let file: string;
  try {
    inbox = realpathSync(inboxDir);
    file = realpathSync(candidate);
  } catch {
    throw new Error('The uploaded image is no longer available in the mobile share inbox');
  }
  const child = relative(inbox, file);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error('Mobile ComfyUI images must come from the share inbox');
  }
  const stat = statSync(file);
  if (!stat.isFile()) throw new Error('The uploaded image must be a file');
  if (stat.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`ComfyUI image input exceeds the ${MAX_ATTACHMENT_BYTES}-byte limit`);
  }
  return file;
}

export class MobileShareInbox implements ShareSink {
  constructor(
    private readonly dir: string,
    private readonly drafts: Pick<DraftManager, 'create'>,
  ) {}

  receive(sessionId: string, filename: string, content: Buffer, draft = true): ShareReceipt {
    const name = safeShareFilename(filename);
    // A per-share folder keeps the user's filename intact and collision-free.
    const folder = join(this.dir, randomUUID());
    mkdirSync(folder, { recursive: true });
    const path = join(folder, name);
    writeFileSync(path, content);
    if (!draft) return { sessionId, path };
    const created = this.drafts.create(sessionId, `Shared: ${name}`, `Attached: ${name} at ${path}`);
    return { sessionId, path, draftId: created.id };
  }
}
