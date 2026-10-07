import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { Protocol } from 'electron';
import { decodeHelmImgUrl, mimeForPath, parseByteRange } from './helm-img-protocol.js';

/** Main-process adapter for the pure helm-img URL and MIME helpers. */
export function registerHelmImgProtocol(protocol: Pick<Protocol, 'handle'>): void {
  protocol.handle('helm-img', async request => {
    const absPath = decodeHelmImgUrl(request.url);
    if (!absPath) return new Response('Missing image path', { status: 404 });

    const mime = mimeForPath(absPath);
    if (mime === null) return new Response('SVG not served via helm-img://', { status: 404 });

    try {
      const file = await stat(absPath);
      const rangeHeader = request.headers.get('range');
      const headers = new Headers({ 'Content-Type': mime, 'Accept-Ranges': 'bytes' });
      if (request.method === 'HEAD') {
        headers.set('Content-Length', String(file.size));
        return new Response(null, { headers });
      }
      if (rangeHeader) {
        const range = parseByteRange(rangeHeader, file.size);
        if (!range) {
          headers.set('Content-Range', `bytes */${file.size}`);
          return new Response(null, { status: 416, headers });
        }
        headers.set('Content-Length', String(range.end - range.start + 1));
        headers.set('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`);
        const body = Readable.toWeb(createReadStream(absPath, { start: range.start, end: range.end }));
        return new Response(body, { status: 206, headers });
      }

      headers.set('Content-Length', String(file.size));
      return new Response(Readable.toWeb(createReadStream(absPath)), { headers });
    } catch {
      return new Response('File not found', { status: 404 });
    }
  });
}
