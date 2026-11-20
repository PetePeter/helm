import { describe, it, expect } from 'vitest';
import { buildCmdScript, isAllowedSetupCommand } from '../src/utils/external-shell-script.js';

describe('buildCmdScript', () => {
  it('turns a multi-line snippet into one batch line per command', () => {
    const script = buildCmdScript('set HELM_MCP_TOKEN=abc\nclaude mcp add helm http://x');
    expect(script).toBe('set HELM_MCP_TOKEN=abc\r\nclaude mcp add helm http://x\r\n');
  });

  it('keeps quotes exactly as written', () => {
    const line = `claude mcp add helm http://x --header "Authorization: Bearer \${HELM_MCP_TOKEN}"`;
    expect(buildCmdScript(line)).toBe(`${line}\r\n`);
  });

  it('drops blank lines and normalises CRLF input', () => {
    expect(buildCmdScript('a\r\n\r\nb\n')).toBe('a\r\nb\r\n');
  });
});

describe('isAllowedSetupCommand', () => {
  it('accepts the MCP setup snippets Helm generates', () => {
    expect(isAllowedSetupCommand('set A=1\ncodex mcp add helm --url http://x')).toBe(true);
    expect(isAllowedSetupCommand('copilot mcp add --transport http helm http://x')).toBe(true);
    expect(isAllowedSetupCommand(
      'if not exist "%USERPROFILE%\\.config\\opencode" mkdir "x"\npowershell -Command "Set-Content -Path \'p\' -Value \'{}\'"',
    )).toBe(true);
  });

  it('refuses anything else', () => {
    expect(isAllowedSetupCommand('del /s /q C:\\')).toBe(false);
    expect(isAllowedSetupCommand('claude mcp add helm x & del C:\\x')).toBe(false);
    expect(isAllowedSetupCommand('')).toBe(false);
  });
});
