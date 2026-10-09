import type { MobileCallInterruption } from './mobile-envelope.js';

interface SentenceSpan {
  start: number;
  end: number;
  text: string;
  complete: boolean;
}

/**
 * Render raw phone progress as ordinary prompt text. Android can report a TTS
 * range start before its buffered audio is audible, so the word is only a hint;
 * we keep the raw offset and do not subtract a guessed margin.
 */
export function renderCallInterruption(report: MobileCallInterruption, userText: string): string {
  const lines = ['Call interruption report:'];
  const offset = report.characterOffset;
  const hasUsablePosition = Number.isSafeInteger(offset)
    && offset! >= 0
    && offset! < report.text.length;

  if (!hasUsablePosition) {
    lines.push('Heard (complete sentences only): none can be confirmed.');
    lines.push('Cut during: position unknown; there is no usable TTS range.');
    lines.push(`Not heard from current reply: ${report.text.trim() || '(empty reply)'}`);
  } else {
    const spans = sentenceSpans(report.text);
    const complete = spans.filter(span => span.complete && span.end <= offset!);
    const cut = spans.find(span => span.start <= offset! && offset! < span.end)
      ?? spans.find(span => span.start >= offset!);
    const word = wordAt(report.text, offset!);
    const remainder = report.text.slice(word?.start ?? offset!).trim();

    lines.push(`Heard (complete sentences only): ${complete.map(span => span.text).join(' ') || 'none confirmed.'}`);
    lines.push(
      cut
        ? `Cut during: ${cut.text}${word ? ` (around “${word.text}”; hint: TTS progress can run ahead of audio.)` : ' (word position unavailable).'}`
        : 'Cut during: position unknown in the active reply.',
    );
    lines.push(`Not heard from current reply: ${remainder || '(no text remains after the reported position)'}`);
  }

  lines.push('Not heard from queued replies:');
  if (report.queuedReplies.length === 0) lines.push('- none');
  else lines.push(...report.queuedReplies.map(reply => `- ${reply}`));
  lines.push(`User's words: ${userText}`);
  return lines.join('\n');
}

function sentenceSpans(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '.' && text[index] !== '!' && text[index] !== '?') continue;
    let end = index + 1;
    while (end < text.length && '"\'”’)]}'.includes(text[end])) end++;
    if (end < text.length && !/\s/u.test(text[end])) continue;
    const sentence = text.slice(start, end).trim();
    if (sentence) spans.push({ start, end, text: sentence, complete: true });
    start = end;
    while (start < text.length && /\s/u.test(text[start])) start++;
    index = end - 1;
  }
  if (start < text.length) {
    const tail = text.slice(start).trim();
    if (tail) spans.push({ start, end: text.length, text: tail, complete: false });
  }
  return spans;
}

function wordAt(text: string, offset: number): { start: number; text: string } | undefined {
  for (const match of text.matchAll(/\S+/gu)) {
    const start = match.index ?? 0;
    if (start <= offset && offset < start + match[0].length) {
      const word = match[0].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      return word ? { start, text: word } : undefined;
    }
  }
  return undefined;
}
