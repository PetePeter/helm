/**
 * Copies the mermaid bundle next to dist-electron/main.js so the
 * helm-artifact:// protocol can serve it to isolated artifact documents.
 *
 * The artifact frame CSP allows no network egress, so an AI-authored HTML
 * artifact that pulls mermaid from a CDN would silently fail. The build
 * therefore ships mermaid locally and buildArtifactDocument rewrites known
 * CDN references to helm-artifact://asset/mermaid.js.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js');
const destDir = join(root, 'dist-electron', 'assets');
const dest = join(destDir, 'mermaid.min.js');

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`[copy-mermaid-asset] ${src} -> ${dest}`);
