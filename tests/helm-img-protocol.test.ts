import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeHelmImgUrl,
  decodeHelmImgUrl,
  mimeForPath,
  parseByteRange,
} from '../src/electron/helm-img-protocol.js';
import { registerHelmImgProtocol } from '../src/electron/helm-img-protocol-handler.js';

describe('encodeHelmImgUrl / decodeHelmImgUrl', () => {
  const roundTrip = (p: string) => decodeHelmImgUrl(encodeHelmImgUrl(p));

  it('round-trips a Windows path with spaces', () => {
    const p = 'C:\\a b\\img.png';
    expect(roundTrip(p)).toBe(p);
  });

  it('round-trips a Windows path with unicode characters', () => {
    const p = 'C:\\Users\\ôscar\\画像\\cat.jpg';
    expect(roundTrip(p)).toBe(p);
  });

  it('round-trips a POSIX path', () => {
    const p = '/home/u/img.png';
    expect(roundTrip(p)).toBe(p);
  });

  it('produces a URL that new URL() parses, with p === original path', () => {
    const p = 'C:\\a b\\img.png';
    const url = new URL(encodeHelmImgUrl(p));
    expect(url.searchParams.get('p')).toBe(p);
  });

  it('encodeHelmImgUrl returns a helm-img://f/ URL with a p query param', () => {
    expect(encodeHelmImgUrl('/home/u/img.png')).toMatch(/^helm-img:\/\/f\/\?p=/);
  });

  it('returns empty string when the p query param is absent', () => {
    expect(decodeHelmImgUrl('helm-img://f/')).toBe('');
  });

  // Simulate Chromium case-folding the authority: the decoder must ignore the
  // host entirely and read the untouched query value, preserving path case.
  const foldHost = (url: string, transform: (host: string) => string): string =>
    url.replace(/^(helm-img:\/\/)([^/?]+)/, (_m, scheme, host) => scheme + transform(host));

  it('survives host case-folding for a mixed-case Windows path (spaces + unicode)', () => {
    const p = 'C:\\Users\\Ôscar\\My Images\\Cat.PNG';
    const encoded = encodeHelmImgUrl(p);
    expect(decodeHelmImgUrl(foldHost(encoded, (h) => h.toUpperCase()))).toBe(p);
    expect(decodeHelmImgUrl(foldHost(encoded, (h) => h.toLowerCase()))).toBe(p);
  });

  it('survives host case-folding for a POSIX path', () => {
    const p = '/home/User/Images/Cat.png';
    const encoded = encodeHelmImgUrl(p);
    expect(decodeHelmImgUrl(foldHost(encoded, (h) => h.toUpperCase()))).toBe(p);
    expect(decodeHelmImgUrl(foldHost(encoded, (h) => h.toLowerCase()))).toBe(p);
  });
});

describe('mimeForPath', () => {
  it('returns image/png for .png', () => {
    expect(mimeForPath('photo.png')).toBe('image/png');
  });

  it('returns image/jpeg for .jpg', () => {
    expect(mimeForPath('photo.jpg')).toBe('image/jpeg');
  });

  it('returns image/jpeg for .jpeg', () => {
    expect(mimeForPath('photo.jpeg')).toBe('image/jpeg');
  });

  it('returns image/gif for .gif', () => {
    expect(mimeForPath('anim.gif')).toBe('image/gif');
  });

  it('returns image/webp for .webp', () => {
    expect(mimeForPath('photo.webp')).toBe('image/webp');
  });

  it('returns image/bmp for .bmp', () => {
    expect(mimeForPath('photo.bmp')).toBe('image/bmp');
  });

  it('returns image/avif for .avif', () => {
    expect(mimeForPath('photo.avif')).toBe('image/avif');
  });

  it('returns browser video MIME types for generated media', () => {
    expect(mimeForPath('movie.mp4')).toBe('video/mp4');
    expect(mimeForPath('movie.webm')).toBe('video/webm');
    expect(mimeForPath('movie.mov')).toBe('video/quicktime');
  });

  it('returns null for .svg (intentionally refused)', () => {
    expect(mimeForPath('icon.svg')).toBeNull();
  });

  it('returns application/octet-stream for unknown extension', () => {
    expect(mimeForPath('data.xyz')).toBe('application/octet-stream');
  });

  it('is case-insensitive for extensions', () => {
    expect(mimeForPath('photo.PNG')).toBe('image/png');
    expect(mimeForPath('photo.JPG')).toBe('image/jpeg');
    expect(mimeForPath('icon.SVG')).toBeNull();
  });

  it('works with full paths, not just filenames', () => {
    expect(mimeForPath('C:\\Users\\user\\images\\photo.png')).toBe('image/png');
    expect(mimeForPath('/home/user/images/photo.webp')).toBe('image/webp');
  });
});

describe('parseByteRange', () => {
  it('supports bounded, open-ended and suffix ranges', () => {
    expect(parseByteRange('bytes=2-5', 10)).toEqual({ start: 2, end: 5 });
    expect(parseByteRange('bytes=8-', 10)).toEqual({ start: 8, end: 9 });
    expect(parseByteRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
  });

  it('rejects out-of-bounds and multi-range requests', () => {
    expect(parseByteRange('bytes=10-', 10)).toBeNull();
    expect(parseByteRange('bytes=5-2', 10)).toBeNull();
    expect(parseByteRange('bytes=0-1,4-5', 10)).toBeNull();
  });
});

describe('registerHelmImgProtocol', () => {
  it('registers through the injected Electron protocol adapter', () => {
    const handle = vi.fn();

    registerHelmImgProtocol({ handle });

    expect(handle).toHaveBeenCalledOnce();
    expect(handle).toHaveBeenCalledWith('helm-img', expect.any(Function));
  });

  it('serves video byte ranges for seeking', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'helm-video-range-'));
    const path = join(dir, 'clip.mp4');
    writeFileSync(path, Buffer.from('0123456789'));
    const handle = vi.fn();
    try {
      registerHelmImgProtocol({ handle });
      const handler = handle.mock.calls[0][1] as (request: unknown) => Promise<Response>;
      const response = await handler({
        url: encodeHelmImgUrl(path),
        method: 'GET',
        headers: new Headers({ range: 'bytes=2-5' }),
      });
      expect(response.status).toBe(206);
      expect(response.headers.get('content-type')).toBe('video/mp4');
      expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
      expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('2345');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
