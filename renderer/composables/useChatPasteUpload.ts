import { reactive } from 'vue';
import { MAX_ATTACHMENT_BYTES } from '../../src/types/artifact-attachment.js';
import type { ChatAttachmentDetails } from '../stores/chat.js';
import { artifactsClient } from '../ipc/clients.js';
import { clipboardFileInput } from '../artifacts/clipboard-file.js';

interface ChatFileSetter {
  (sessionId: string, path: string | null, details?: ChatAttachmentDetails): void;
}

interface UploadingFile {
  filename: string;
  sizeBytes: number;
}

function clipboardFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = Array.from(data.files);
  if (files.length) return files;

  return Array.from(data.items)
    .filter(item => item.kind === 'file')
    .map(item => {
      try {
        return item.getAsFile();
      } catch {
        return null;
      }
    })
    .filter((file): file is File => file !== null);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useChatPasteUpload(setAttachment: ChatFileSetter) {
  const uploadingBySession = reactive(new Map<string, UploadingFile>());
  const errorsBySession = reactive(new Map<string, string>());

  function isUploading(sessionId: string): boolean {
    return uploadingBySession.has(sessionId);
  }

  function uploadingFile(sessionId: string): UploadingFile | undefined {
    return uploadingBySession.get(sessionId);
  }

  function errorFor(sessionId: string): string | undefined {
    return errorsBySession.get(sessionId);
  }

  function clearError(sessionId: string): void {
    errorsBySession.delete(sessionId);
  }

  async function onPaste(sessionId: string | undefined, event: ClipboardEvent): Promise<void> {
    if (!sessionId) return;
    const files = clipboardFiles(event.clipboardData);
    if (!files.length) return;

    event.preventDefault();
    if (isUploading(sessionId)) {
      errorsBySession.set(sessionId, 'Wait for the current file upload to finish before pasting another file.');
      return;
    }
    if (files.length !== 1) {
      errorsBySession.set(sessionId, 'Paste one file at a time.');
      return;
    }

    const file = files[0];
    const filename = file.name || 'Pasted file';
    if (file.size > MAX_ATTACHMENT_BYTES) {
      errorsBySession.set(sessionId, 'File exceeds the 10MB attachment size limit.');
      return;
    }

    errorsBySession.delete(sessionId);
    uploadingBySession.set(sessionId, { filename, sizeBytes: file.size });
    try {
      const input = await clipboardFileInput(file, file.name || undefined);
      const attachment = await artifactsClient.artifactChatAttachmentUpload(sessionId, input);
      if (!attachment?.filePath) throw new Error('Upload did not return a local attachment path.');
      setAttachment(sessionId, attachment.filePath, {
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        artifactId: attachment.artifactId,
        attachmentId: attachment.attachmentId,
      });
      errorsBySession.delete(sessionId);
    } catch (error) {
      errorsBySession.set(sessionId, errorText(error));
    } finally {
      uploadingBySession.delete(sessionId);
    }
  }

  return { isUploading, uploadingFile, errorFor, clearError, onPaste };
}
