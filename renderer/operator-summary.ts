/**
 * The sidebar's pinned "Helm" section — the desktop twin of the phone's
 * OperatorSummary.kt. The operator lives in its own section, so the regular
 * session list never shows it twice.
 */
import type { Session } from './state.js';
import type { VoiceTranscriptLine } from './voice/voice-call.js';

export type OperatorSummary =
  | { kind: 'off' }
  | { kind: 'on'; id: string; activityLevel: string; lastReply: string | null };

export function operatorSummary(
  sessions: readonly Pick<Session, 'id' | 'role'>[],
  activityLevels: ReadonlyMap<string, string>,
  transcript: readonly VoiceTranscriptLine[],
): OperatorSummary {
  const operator = sessions.find(session => session.role === 'operator');
  if (!operator) return { kind: 'off' };
  const lastReply = [...transcript].reverse().find(line => line.from === 'helm')?.text ?? null;
  return { kind: 'on', id: operator.id, activityLevel: activityLevels.get(operator.id) ?? 'idle', lastReply };
}

export function withoutOperator<T extends Pick<Session, 'role'>>(sessions: readonly T[]): T[] {
  return sessions.filter(session => session.role !== 'operator');
}
