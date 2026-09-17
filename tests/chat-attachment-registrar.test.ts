import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactAttachmentManager } from '../src/session/artifact-attachment-manager.js';
import {
  CHAT_FILES_TITLE,
  createChatAttachmentRegistrar,
  type ChatAttachmentArtifacts,
} from '../src/session/chat/chat-attachment-registrar.js';
import { ChatBroker } from '../src/session/chat/chat-broker.js';
import type { Artifact } from '../src/types/artifact.js';
import type { ChatBridge, ChatOutboundMessage } from '../src/session/chat/chat-bridge.js';

/**
 * A real-enough artifact store: the registrar's whole job is deciding WHICH
 * artifact a chat file is filed under, and a mock that answers whatever it is
 * asked would not test that decision.
 */
class FakeArtifacts implements ChatAttachmentArtifacts {
  private readonly bySession = new Map<string, Artifact[]>();
  creates = 0;

  getForSession(sessionId: string): Artifact[] {
    return this.bySession.get(sessionId) ?? [];
  }

  create(sessionId: string, title: string): Artifact {
    this.creates++;
    const artifact = {
      id: `art-${this.creates}`,
      sessionId,
      title,
      kind: 'markdown',
      versions: [{ version: 1, content: '', createdAt: 1 }],
      createdAt: 1,
      updatedAt: 1,
    } as unknown as Artifact;
    this.bySession.set(sessionId, [...this.getForSession(sessionId), artifact]);
    return artifact;
  }
}

describe('chat attachment registrar', () => {
  let configDir: string;
  let sourceDir: string;
  let attachments: ArtifactAttachmentManager;
  let artifacts: FakeArtifacts;
  let register: ReturnType<typeof createChatAttachmentRegistrar>;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'helm-chatfile-'));
    sourceDir = join(configDir, 'source');
    mkdirSync(sourceDir);
    attachments = new ArtifactAttachmentManager(configDir);
    artifacts = new FakeArtifacts();
    register = createChatAttachmentRegistrar({ artifacts, attachments });
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  function writeSource(name: string, body = 'hello'): string {
    const path = join(sourceDir, name);
    writeFileSync(path, body);
    return path;
  }

  it('takes its own copy so the file survives the caller deleting theirs', () => {
    const path = writeSource('report.png', 'image-bytes');
    const ref = register('s1', path)!;

    rmSync(path);

    const slice = attachments.readSlice(ref.artifactId, ref.attachmentId);
    expect(slice.bytes.toString()).toBe('image-bytes');
  });

  it('describes the file well enough to draw a tile before fetching it', () => {
    const ref = register('s1', writeSource('holiday.jpg', 'jpeg'))!;

    expect(ref.filename).toBe('holiday.jpg');
    expect(ref.mimeType).toBe('image/jpeg');
    expect(ref.sizeBytes).toBe(4);
  });

  it('files every chat file of a session under ONE artifact', () => {
    // One row per file would bury a session's real reports under forty of them.
    const first = register('s1', writeSource('a.png'))!;
    const second = register('s1', writeSource('b.png'))!;

    expect(second.artifactId).toBe(first.artifactId);
    expect(second.attachmentId).not.toBe(first.attachmentId);
    expect(artifacts.creates).toBe(1);
    expect(artifacts.getForSession('s1')[0].title).toBe(CHAT_FILES_TITLE);
  });

  it('keeps sessions apart', () => {
    const mine = register('s1', writeSource('a.png'))!;
    const theirs = register('s2', writeSource('b.png'))!;

    expect(theirs.artifactId).not.toBe(mine.artifactId);
  });

  it('gives up quietly on a file that is not there', () => {
    // The message still has to go out; a lost file must not become a lost message.
    expect(register('s1', join(sourceDir, 'ghost.png'))).toBeUndefined();
    expect(artifacts.creates).toBe(0);
  });

  it('gives up quietly on a file past the size limit', () => {
    const path = join(sourceDir, 'huge.bin');
    writeFileSync(path, Buffer.alloc(11 * 1024 * 1024));

    expect(register('s1', path)).toBeUndefined();
  });
});

/** A bridge that records what it was handed, nothing more. */
class RecordingBridge implements ChatBridge {
  readonly seen: ChatOutboundMessage[] = [];
  constructor(readonly provider: string, private readonly available = true) {}
  isAvailable(): boolean {
    return this.available;
  }
  async sendToSession(message: ChatOutboundMessage) {
    this.seen.push(message);
    return { sent: true };
  }
}

describe('ChatBroker attachment registration', () => {
  it('registers the file ONCE however many surfaces are live', async () => {
    // Registering per bridge would store one photo twice and give the two
    // surfaces different ids for a file the user sent once.
    let calls = 0;
    const broker = new ChatBroker({
      registerAttachment: () => {
        calls++;
        return {
          artifactId: 'art-1',
          attachmentId: `att-${calls}`,
          filename: 'a.png',
          mimeType: 'image/png',
          sizeBytes: 3,
        };
      },
    });
    const telegram = new RecordingBridge('telegram');
    const mobile = new RecordingBridge('mobile');
    broker.register(telegram);
    broker.register(mobile);

    await broker.send({ sessionId: 's1', text: 'look', filePath: 'C:\\tmp\\a.png' });

    expect(calls).toBe(1);
    expect(telegram.seen[0].attachment?.attachmentId).toBe('att-1');
    expect(mobile.seen[0].attachment?.attachmentId).toBe('att-1');
  });

  it('leaves a bridge that carries paths untouched', async () => {
    const broker = new ChatBroker({ registerAttachment: () => undefined });
    const telegram = new RecordingBridge('telegram');
    broker.register(telegram);

    await broker.send({ sessionId: 's1', text: 'look', filePath: 'C:\\tmp\\a.png' });

    // Telegram uploads the bytes itself; losing the path would break a path
    // that already works.
    expect(telegram.seen[0].filePath).toBe('C:\\tmp\\a.png');
    expect(telegram.seen[0].attachment).toBeUndefined();
  });

  it('still delivers the message when taking the file throws', async () => {
    const broker = new ChatBroker({
      registerAttachment: () => {
        throw new Error('disk full');
      },
    });
    const mobile = new RecordingBridge('mobile');
    broker.register(mobile);

    const results = await broker.send({ sessionId: 's1', text: 'look', filePath: 'C:\\tmp\\a.png' });

    expect(results[0].sent).toBe(true);
    expect(mobile.seen[0].attachment).toBeUndefined();
  });

  it('does not touch a message with no file', async () => {
    let calls = 0;
    const broker = new ChatBroker({
      registerAttachment: () => {
        calls++;
        return undefined;
      },
    });
    broker.register(new RecordingBridge('mobile'));

    await broker.send({ sessionId: 's1', text: 'just words' });

    expect(calls).toBe(0);
  });
});
