/**
 * Stream an HTTP download straight to disk, reporting progress.
 *
 * Shared by the self-update installer and the telefony-app install. Both
 * payloads are hundreds of MB and the main process hosts every PTY, so the
 * body must never be buffered in memory. A failed or truncated download
 * leaves no partial file behind.
 */
import * as fs from 'fs';

export type FetchFn = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

export interface DownloadProgress {
  percent: number;
  receivedBytes: number;
  totalBytes?: number;
}

export async function downloadToFile(
  fetchFn: FetchFn,
  url: string,
  destPath: string,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<void> {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(600_000) });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  if (!response.body) throw new Error('Download failed: empty response body');

  const total = Number(response.headers.get('content-length')) || undefined;
  let received = 0;
  let lastPercent = -1;
  const out = fs.createWriteStream(destPath);
  try {
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      const buf = Buffer.from(chunk);
      await new Promise<void>((resolve, reject) => {
        out.write(buf, err => (err ? reject(err) : resolve()));
      });
      received += buf.length;
      const percent = total ? Math.floor((received / total) * 100) : 0;
      if (percent > lastPercent) {
        lastPercent = percent;
        onProgress?.({ percent, receivedBytes: received, totalBytes: total });
      }
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } catch (error) {
    out.destroy();
    fs.rmSync(destPath, { force: true });
    throw error;
  }
  if (total && received !== total) {
    fs.rmSync(destPath, { force: true });
    throw new Error(`Download truncated: ${received} of ${total} bytes`);
  }
}
