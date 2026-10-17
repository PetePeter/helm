import type { ChatRecordInput } from '../src/mobile/mobile-envelope.js';

export interface ChatTextSegment {
  text: string;
  href?: string;
}

const WEB_LINK = /https?:\/\/[^\s<>"']+/gi;
const TRAILING_PUNCTUATION = /[.,!?;:)\]}]+$/;

/** A user turn's origin comes from the journal ID namespace. */
export function chatOriginLabel(record: Pick<ChatRecordInput, 'originId'>): 'Phone' | 'Desktop' | 'Telegram' | null {
  const originId = record.originId?.toLowerCase();
  if (!originId) return null;
  if (originId.startsWith('desktop:')) return 'Desktop';
  if (originId.startsWith('telegram:') || originId.startsWith('tg:')) return 'Telegram';
  return 'Phone';
}

/** Split plain text into safe web links and text; non-http schemes remain inert. */
export function splitChatLinks(text: string): ChatTextSegment[] {
  const segments: ChatTextSegment[] = [];
  let previousEnd = 0;

  for (const match of text.matchAll(WEB_LINK)) {
    const start = match.index ?? 0;
    const candidate = match[0];
    const trimmed = candidate.replace(TRAILING_PUNCTUATION, '');
    if (!trimmed) continue;
    if (start > previousEnd) segments.push({ text: text.slice(previousEnd, start) });
    segments.push({ text: trimmed, href: trimmed });
    const tail = candidate.slice(trimmed.length);
    if (tail) segments.push({ text: tail });
    previousEnd = start + candidate.length;
  }

  if (previousEnd < text.length) segments.push({ text: text.slice(previousEnd) });
  return segments.length ? segments : [{ text }];
}

export function formatChatFileSize(sizeBytes: number | undefined): string | undefined {
  if (sizeBytes === undefined || !Number.isFinite(sizeBytes) || sizeBytes < 0) return undefined;
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
}
