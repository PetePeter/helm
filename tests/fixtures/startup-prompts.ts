// Known text, not raw capture; verify live.
export const knownStartupPromptText = {
  claudeCode: 'Do you trust the files in this folder?',
  codexTrust: 'Do you trust the contents of this directory?',
  codexAllow: 'Allow Codex to work in this folder',
  copilotConfirm: 'Confirm folder trust',
  copilotTrust: 'Do you trust the files in this folder?',
} as const;

export function ansiSplit(text: string): [string, string] {
  const splitAt = Math.floor(text.length / 2);
  return [`\x1b[33m${text.slice(0, splitAt)}`, `${text.slice(splitAt)}\x1b[0m`];
}

export function ansiEscapeSplitInsideText(text: string): [string, string] {
  const splitAt = text.indexOf('trust') + 2;
  return [`${text.slice(0, splitAt)}\x1b[3`, `3m${text.slice(splitAt)}\x1b[0m`];
}
