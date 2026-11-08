import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { atomicWriteFileSync } from './persistence-utils.js';
import { getMessCursorPath, getMessLogPath } from './persistence-paths.js';
import type { MessCursor, MessEntry, MessEntryInput } from '../types/mess.js';

const STORE_VERSION = 1;
const COMPACTION_SUFFIX = '.compacting';

export interface MessDiagnostic {
  kind: 'corrupt' | 'invalid';
  message: string;
  filePath: string;
  line?: number;
}

export interface MessLoadResult {
  entries: MessEntry[];
  diagnostics: MessDiagnostic[];
  oldestSeq?: number;
  prunedThroughSeq?: number;
}

export interface MessCursorLoadResult {
  cursors: MessCursor[];
  diagnostic?: MessDiagnostic;
}

export interface MessPersistenceOptions {
  directory: string;
  now?: () => number;
  idFactory?: () => string;
  atomicWrite?: (filePath: string, content: string) => void;
}

/**
 * Durable project Mess storage.
 *
 * The main process is the single writer. Sharing this config directory between
 * multiple Helm processes is not safe without adding an interprocess lock.
 * Entries use a per-project sequence number; wall-clock time is display data
 * only and is never used as a cursor key.
 */
export class MessPersistence {
  readonly logPath: string;
  readonly cursorPath: string;
  private readonly compactingPath: string;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly atomicWrite: (filePath: string, content: string) => void;

  constructor(readonly projectId: string, options: MessPersistenceOptions) {
    const directory = options.directory;
    this.logPath = getMessLogPath(projectId, directory);
    this.cursorPath = getMessCursorPath(projectId, directory);
    this.compactingPath = `${this.logPath}${COMPACTION_SUFFIX}`;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.atomicWrite = options.atomicWrite ?? atomicWriteFileSync;
  }

  load(): MessLoadResult {
    const diagnostics: MessDiagnostic[] = [];
    this.recoverCompaction(diagnostics);
    const metadata = this.readMetadata(diagnostics);
    if (!existsSync(this.logPath)) {
      return {
        entries: [],
        diagnostics,
        ...(metadata.prunedThroughSeq > 0 ? { oldestSeq: metadata.prunedThroughSeq + 1 } : {}),
        ...(metadata.prunedThroughSeq > 0 ? { prunedThroughSeq: metadata.prunedThroughSeq } : {}),
      };
    }

    let raw: string;
    try {
      raw = readFileSync(this.logPath, 'utf8');
    } catch (error) {
      return { entries: [], diagnostics: [...diagnostics, this.diagnostic('corrupt', `Unable to read Mess log: ${String(error)}`)] };
    }

    const lines = raw.split(/\r?\n/);
    while (lines.length > 0 && lines.at(-1) === '') lines.pop();
    const entries: MessEntry[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        const entry = normalizeEntry(parsed, this.projectId);
        if (!entry) throw new Error('invalid entry shape');
        entries.push(entry);
      } catch (error) {
        diagnostics.push(this.diagnostic(
          'corrupt',
          `${index === lines.length - 1 ? 'Malformed final' : 'Malformed'} Mess JSONL line: ${String(error)}`,
          index + 1,
        ));
      }
    }
    entries.sort((a, b) => a.seq - b.seq);
    return {
      entries,
      diagnostics,
      ...(entries.length > 0
        ? { oldestSeq: entries[0].seq }
        : metadata.prunedThroughSeq > 0
          ? { oldestSeq: metadata.prunedThroughSeq + 1 }
          : {}),
      ...(metadata.prunedThroughSeq > 0 ? { prunedThroughSeq: metadata.prunedThroughSeq } : {}),
    };
  }

  append(input: MessEntryInput): MessEntry {
    const metadata = this.requireMetadata();
    let nextSeq = metadata.nextSeq;
    // Migrate a pre-metadata log and repair a crash that appended the log line
    // before its metadata replacement completed. This scan is only needed for
    // those recovery cases; normal appends use the durable counter.
    const loaded = metadata.hasStoredNextSeq ? undefined : this.load();
    if (loaded) nextSeq = Math.max(nextSeq, maxSeq(loaded.entries) + 1);
    const entry = normalizeEntry({ ...input, id: input.id ?? this.idFactory(), seq: nextSeq }, this.projectId);
    if (!entry) throw new Error('Invalid Mess entry');
    mkdirSync(dirname(this.logPath), { recursive: true });
    // Reserve the sequence before appending. A crash after this write can
    // leave a harmless unused sequence, but can never cause a duplicate after
    // the metadata write has become durable.
    this.saveMetadata({ ...metadata, nextSeq: nextSeq + 1 });
    appendFileSync(this.logPath, `${JSON.stringify(entry)}\n`, 'utf8');
    return entry;
  }

  /** Remove entries older than the supplied age and atomically replace the log. */
  prune(retentionDays: number, now = this.now()): { removed: number; oldestSeq?: number; diagnostics: MessDiagnostic[] } {
    const loaded = this.load();
    const cutoff = now - Math.max(0, retentionDays) * 24 * 60 * 60 * 1000;
    const retained = loaded.entries.filter(entry => entry.createdAt >= cutoff);
    const removedEntries = loaded.entries.filter(entry => entry.createdAt < cutoff);
    const removed = loaded.entries.length - retained.length;
    const prunedThroughSeq = Math.max(loaded.prunedThroughSeq ?? 0, maxSeq(removedEntries));
    if (removed > 0) {
      const metadata = this.requireMetadata();
      // Record the floor before replacing the log. If the process stops after
      // this write, the old log remains readable; if it stops during the
      // replacement, reload may conservatively over-report a gap but never
      // hides that pruning advanced the floor.
      this.saveMetadata({
        ...metadata,
        nextSeq: Math.max(metadata.nextSeq, maxSeq(loaded.entries) + 1),
        prunedThroughSeq,
      });
      this.compact(retained);
    }
    return {
      removed,
      diagnostics: loaded.diagnostics,
      ...(retained.length > 0
        ? { oldestSeq: retained[0].seq }
        : removed > 0
          ? { oldestSeq: prunedThroughSeq + 1 }
          : loaded.oldestSeq === undefined ? {} : { oldestSeq: loaded.oldestSeq }),
      ...(removed > 0 ? { prunedThroughSeq } : {}),
    };
  }

  compact(entries = this.load().entries): void {
    const content = entries.map(entry => JSON.stringify(entry)).join('\n');
    const payload = content ? `${content}\n` : '';
    this.atomicWrite(this.compactingPath, payload);
    renameSync(this.compactingPath, this.logPath);
  }

  loadCursors(): MessCursorLoadResult {
    const diagnostics: MessDiagnostic[] = [];
    const metadata = this.readMetadata(diagnostics);
    return diagnostics.length > 0 ? { cursors: [], diagnostic: diagnostics[0] } : { cursors: metadata.cursors };
  }

  getCursor(sessionId: string): MessCursor | undefined {
    return this.loadCursors().cursors.find(cursor => cursor.sessionId === sessionId);
  }

  saveCursor(cursor: MessCursor): void {
    const normalized = normalizeCursor(cursor, this.projectId);
    if (!normalized) throw new Error('Invalid Mess cursor');
    const metadata = this.ensureMetadataCounters(this.requireMetadata());
    const cursors = metadata.cursors.filter(existing => existing.sessionId !== cursor.sessionId);
    cursors.push(normalized);
    cursors.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    this.saveMetadata({ ...metadata, cursors });
  }

  deleteCursor(sessionId: string): boolean {
    const metadata = this.ensureMetadataCounters(this.requireMetadata());
    const cursors = metadata.cursors.filter(cursor => cursor.sessionId !== sessionId);
    if (cursors.length === metadata.cursors.length) return false;
    this.saveMetadata({ ...metadata, cursors });
    return true;
  }

  purge(): void {
    for (const path of [this.logPath, this.cursorPath, this.compactingPath]) {
      if (existsSync(path)) unlinkSync(path);
    }
  }

  private recoverCompaction(diagnostics: MessDiagnostic[]): void {
    if (!existsSync(this.compactingPath)) return;
    if (existsSync(this.logPath)) {
      // The primary was last known good; a leftover temp is an interrupted
      // replacement and must not overwrite it.
      try { unlinkSync(this.compactingPath); } catch (error) {
        diagnostics.push(this.diagnostic('corrupt', `Unable to remove stale Mess compaction: ${String(error)}`, undefined, this.compactingPath));
      }
      return;
    }
    try {
      const raw = readFileSync(this.compactingPath, 'utf8');
      for (const line of raw.split(/\r?\n/).filter(Boolean)) {
        if (!normalizeEntry(JSON.parse(line) as unknown, this.projectId)) throw new Error('invalid compacted entry');
      }
      renameSync(this.compactingPath, this.logPath);
    } catch (error) {
      diagnostics.push(this.diagnostic('corrupt', `Unable to recover Mess compaction: ${String(error)}`, undefined, this.compactingPath));
    }
  }

  private diagnostic(kind: MessDiagnostic['kind'], message: string, line?: number, filePath = this.logPath): MessDiagnostic {
    return { kind, message, filePath, ...(line === undefined ? {} : { line }) };
  }

  private readMetadata(diagnostics: MessDiagnostic[]): MessMetadata {
    if (!existsSync(this.cursorPath)) return emptyMetadata();
    try {
      const parsed = JSON.parse(readFileSync(this.cursorPath, 'utf8')) as unknown;
      if (!isRecord(parsed) || parsed.version !== STORE_VERSION || !Array.isArray(parsed.cursors)) {
        throw new Error('invalid cursor store envelope');
      }
      const cursors = parsed.cursors.map(value => normalizeCursor(value, this.projectId));
      if (cursors.some(cursor => cursor === null)) throw new Error('invalid cursor');
      const hasNextSeq = parsed.nextSeq !== undefined;
      const hasPrunedThroughSeq = parsed.prunedThroughSeq !== undefined;
      if (hasNextSeq && (!Number.isSafeInteger(parsed.nextSeq) || parsed.nextSeq < 1)) throw new Error('invalid next sequence');
      if (hasPrunedThroughSeq && (!Number.isSafeInteger(parsed.prunedThroughSeq) || parsed.prunedThroughSeq < 0)) throw new Error('invalid pruned sequence');
      return {
        cursors: cursors as MessCursor[],
        nextSeq: hasNextSeq ? parsed.nextSeq : 1,
        prunedThroughSeq: hasPrunedThroughSeq ? parsed.prunedThroughSeq : 0,
        hasStoredNextSeq: hasNextSeq && hasPrunedThroughSeq,
      };
    } catch (error) {
      diagnostics.push(this.diagnostic('corrupt', `Invalid Mess cursor store: ${String(error)}`, undefined, this.cursorPath));
      return { ...emptyMetadata(), hasStoredNextSeq: true };
    }
  }

  private requireMetadata(): MessMetadata {
    const diagnostics: MessDiagnostic[] = [];
    const metadata = this.readMetadata(diagnostics);
    if (diagnostics.length > 0) throw new Error(`Cannot update corrupt Mess metadata: ${diagnostics[0].message}`);
    return metadata;
  }

  private ensureMetadataCounters(metadata: MessMetadata): MessMetadata {
    if (metadata.hasStoredNextSeq) return metadata;
    const loaded = this.load();
    return { ...metadata, nextSeq: Math.max(metadata.nextSeq, maxSeq(loaded.entries) + 1), hasStoredNextSeq: true };
  }

  private saveMetadata(metadata: MessMetadata): void {
    this.atomicWrite(this.cursorPath, `${JSON.stringify({
      version: STORE_VERSION,
      nextSeq: metadata.nextSeq,
      prunedThroughSeq: metadata.prunedThroughSeq,
      cursors: metadata.cursors,
    }, null, 2)}\n`);
  }
}

interface MessMetadata {
  cursors: MessCursor[];
  nextSeq: number;
  prunedThroughSeq: number;
  hasStoredNextSeq: boolean;
}

function emptyMetadata(): MessMetadata {
  return { cursors: [], nextSeq: 1, prunedThroughSeq: 0, hasStoredNextSeq: false };
}

function maxSeq(entries: MessEntry[]): number {
  return entries.reduce((max, entry) => Math.max(max, entry.seq), 0);
}

function normalizeEntry(value: unknown, projectId: string): MessEntry | null {
  if (!isRecord(value) || value.projectId !== projectId) return null;
  if (typeof value.id !== 'string' || !value.id || !Number.isSafeInteger(value.seq) || value.seq < 1) return null;
  if (typeof value.fromSessionId !== 'string' || !value.fromSessionId || typeof value.fromLabelSnapshot !== 'string') return null;
  if (value.toSessionId !== undefined && (typeof value.toSessionId !== 'string' || !value.toSessionId)) return null;
  if (value.toLabelSnapshot !== undefined && typeof value.toLabelSnapshot !== 'string') return null;
  if (typeof value.text !== 'string' || !value.text || !Number.isFinite(value.createdAt)) return null;
  return {
    id: value.id,
    projectId,
    seq: value.seq,
    fromSessionId: value.fromSessionId,
    fromLabelSnapshot: value.fromLabelSnapshot,
    ...(value.toSessionId === undefined ? {} : { toSessionId: value.toSessionId }),
    ...(value.toLabelSnapshot === undefined ? {} : { toLabelSnapshot: value.toLabelSnapshot }),
    text: value.text,
    createdAt: value.createdAt,
  };
}

function normalizeCursor(value: unknown, projectId: string): MessCursor | null {
  if (!isRecord(value) || value.projectId !== projectId) return null;
  if (typeof value.sessionId !== 'string' || !value.sessionId) return null;
  if (!Number.isSafeInteger(value.lastSeq) || value.lastSeq < 0 || !Number.isFinite(value.joinedAt)) return null;
  return {
    projectId,
    sessionId: value.sessionId,
    lastSeq: value.lastSeq,
    joinedAt: value.joinedAt,
    ...(value.joinNoticeSent === true ? { joinNoticeSent: true } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
