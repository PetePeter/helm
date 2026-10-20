import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubagentTokenIngest } from '../../src/session/subagent-token-ingest.js';
import { TimeTracker } from '../../src/session/time-tracker.js';
import { TimePersistence } from '../../src/session/time-persistence.js';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const NOW = new Date(2026, 8, 28, 9, 0).getTime();
const reply = (context: number) => JSON.stringify({ type: 'assistant', message: { usage: { cache_read_input_tokens: context, output_tokens: 0 } } }) + '\n';

let root: string;
let transcript: string;
let agentFile: string;
let tracker: TimeTracker;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'helm-ingest-'));
  transcript = join(root, 'sess.jsonl');
  writeFileSync(transcript, reply(1_000));
  mkdirSync(join(root, 'sess', 'subagents'), { recursive: true });
  agentFile = join(root, 'sess', 'subagents', 'agent-a.jsonl');
  tracker = new TimeTracker({
    persistence: new TimePersistence(join(root, 'ledger')),
    resolve: () => ({ projectKey: 'p', projectName: 'P', dir: 'C:/p', cliType: 'claude-code' }),
    now: () => NOW,
  });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const total = () => tracker.query(0, NOW + 1e9).reduce((n, s) => n + (s.tokens ?? 0), 0);
const session = (extra: Record<string, unknown> = {}) => ({ id: 's1', cliTranscriptPath: transcript, ...extra });

describe('SubagentTokenIngest', () => {
  it('picks up sub-agent growth on every sweep, with no main-context change needed', () => {
    const ingest = new SubagentTokenIngest(tracker, false);
    writeFileSync(agentFile, reply(20_000));
    ingest.sweep([session()]);
    ingest.sweep([session()]); // nothing new
    appendFileSync(agentFile, reply(35_000));
    ingest.sweep([session()]);
    expect(total()).toBe(35_000);
  });

  it('reads sessions whose main context is unknown, such as right after /compact', () => {
    const ingest = new SubagentTokenIngest(tracker, false);
    writeFileSync(agentFile, reply(8_000));
    ingest.sweep([session({ contextUsage: undefined })]);
    expect(total()).toBe(8_000);
  });

  it('skips remote sessions, which their own machine counts', () => {
    const ingest = new SubagentTokenIngest(tracker, false);
    writeFileSync(agentFile, reply(8_000));
    ingest.sweep([session({ remote: true })]);
    expect(total()).toBe(0);
  });

  it('with no saved baselines, the first sweep of a session only primes: earlier runs counted that context', () => {
    const ingest = new SubagentTokenIngest(tracker, true);
    writeFileSync(agentFile, reply(20_000));
    ingest.sweep([session()]);
    appendFileSync(agentFile, reply(25_000));
    ingest.sweep([session()]);
    expect(total()).toBe(5_000);
  });
});
