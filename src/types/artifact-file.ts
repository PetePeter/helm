/** Shared file-to-artifact classification and text rendering rules. */

/** Files larger than this remain stored as attachments instead of inline text. */
export const TEXT_INLINE_MAX_BYTES = 1_000_000;

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd']);
const HTML_EXTENSIONS = new Set(['html', 'htm']);

/** Extensions inlined as fenced code. Value is the fence language tag. */
const CODE_EXTENSIONS: Record<string, string> = {
  txt: '', log: '', text: '', env: '', ini: '', cfg: '', conf: '', properties: '',
  json: 'json', jsonc: 'json', csv: 'csv', tsv: '', xml: 'xml', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js', vue: 'html',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', bat: '', cmd: '',
  sql: 'sql', css: 'css', scss: 'css', svg: 'xml',
  gradle: '', dockerfile: '', gitignore: '', patch: 'diff', diff: 'diff',
};

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

export function isTextLikeFile(filename: string, contentType?: string): boolean {
  const ext = extensionOf(filename);
  if (MARKDOWN_EXTENSIONS.has(ext) || HTML_EXTENSIONS.has(ext) || ext in CODE_EXTENSIONS) return true;
  return (contentType ?? '').toLowerCase().startsWith('text/');
}

function fenceFor(text: string): string {
  const longest = [...text.matchAll(/`{3,}/g)].reduce((max, match) => Math.max(max, match[0].length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

export interface TextArtifactDraft {
  title: string;
  kind: 'markdown' | 'html';
  content: string;
}

export function buildTextArtifact(filename: string, text: string): TextArtifactDraft {
  const ext = extensionOf(filename);
  if (MARKDOWN_EXTENSIONS.has(ext)) return { title: filename, kind: 'markdown', content: text };
  if (HTML_EXTENSIONS.has(ext)) return { title: filename, kind: 'html', content: text };

  const fence = fenceFor(text);
  const lang = CODE_EXTENSIONS[ext] ?? '';
  return { title: filename, kind: 'markdown', content: `${fence}${lang}\n${text}\n${fence}` };
}
