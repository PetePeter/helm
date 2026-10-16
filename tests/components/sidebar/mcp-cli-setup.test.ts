/**
 * McpCliSetup component tests — OS-dependent snippet/button behavior.
 *
 * The "Run in <shell>" button and the generated snippets must match the shell
 * that doSpawnShell() opens: cmd.exe on Windows, the user's $SHELL on
 * macOS/Linux.
 *
 * NOTE: these tests stub `window.helmPlatform` (the preload-exposed constant),
 * NOT `process.platform`. An earlier version of this suite stubbed
 * process.platform and passed green while the shipped app was broken on macOS —
 * `process` is undefined in the real renderer (contextIsolation:true,
 * nodeIntegration:false, no Vite define), so every platform branch resolved to
 * Windows. Stubbing the real mechanism is what makes these tests meaningful.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import McpCliSetup from '../../../renderer/components/settings/pages/McpCliSetup.vue';

function setPlatform(value: NodeJS.Platform): void {
  (window as any).helmPlatform = value;
}

async function mountSetup() {
  const wrapper = mount(McpCliSetup, {
    props: {
      endpoint: 'http://127.0.0.1:47421/mcp',
      tokenLiteral: 'secret-token',
    },
  });
  await wrapper.vm.$nextTick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  return wrapper;
}

describe('McpCliSetup.vue OS-dependent behavior', () => {
  beforeEach(() => {
    // Provide an env var per CLI so envSetupLines() is exercised.
    (window as any).gamepadCli = {
      configGetCliTypes: vi.fn().mockResolvedValue(['codex', 'opencode']),
      configGetCliTypeEnv: vi.fn().mockResolvedValue([{ name: 'FOO', value: 'bar' }]),
    };
  });

  afterEach(() => {
    delete (window as any).helmPlatform;
  });

  it('uses POSIX syntax and a matching label on macOS', async () => {
    setPlatform('darwin');
    const wrapper = await mountSetup();
    const text = wrapper.text();

    expect(text).toContain('Run in zsh');
    expect(text).not.toContain('Run in cmd.exe');
    expect(text).toContain('export FOO=bar'); // not "set FOO=bar"
    expect(text).toContain('mkdir -p'); // opencode: POSIX file write
    expect(text).toContain('$HOME/.config/opencode');
    expect(text).not.toContain('%USERPROFILE%');
    expect(text).not.toContain('powershell');
  });

  it('uses bash as the label on Linux', async () => {
    setPlatform('linux');
    const wrapper = await mountSetup();
    expect(wrapper.text()).toContain('Run in bash');
  });

  it('uses cmd.exe syntax and label on Windows', async () => {
    setPlatform('win32');
    const wrapper = await mountSetup();
    const text = wrapper.text();

    expect(text).toContain('Run in cmd.exe');
    expect(text).not.toContain('Run in zsh');
    expect(text).toContain('cmd.exe syntax');
    expect(text).toContain('set FOO=bar'); // not "export FOO=bar"
    expect(text).toContain('%USERPROFILE%');
    expect(text).toContain('powershell');
    expect(text).not.toContain('mkdir -p');
  });

  it('defaults to Windows behaviour when no platform is exposed', async () => {
    delete (window as any).helmPlatform;
    const wrapper = await mountSetup();
    expect(wrapper.text()).toContain('Run in cmd.exe');
  });
});

/**
 * The core cross-platform correctness property.
 *
 * ${HELM_MCP_TOKEN} must reach the client's config file UNEXPANDED so the CLI
 * resolves it per-launch from the PTY env, giving each Helm session its own
 * HMAC-minted, session-scoped token. cmd.exe has no ${...} syntax so double
 * quotes suffice; POSIX shells expand it at registration time, which froze one
 * session's token into the config forever and 401'd every later session.
 */
describe('McpCliSetup.vue placeholder preservation', () => {
  beforeEach(() => {
    (window as any).gamepadCli = {
      configGetCliTypes: vi.fn().mockResolvedValue(['claude', 'copilot', 'codex']),
      configGetCliTypeEnv: vi.fn().mockResolvedValue([]),
    };
  });

  afterEach(() => {
    delete (window as any).helmPlatform;
  });

  it('single-quotes placeholder-bearing headers on POSIX', async () => {
    setPlatform('darwin');
    const text = (await mountSetup()).text();

    expect(text).toContain("--header 'Authorization: Bearer ${HELM_MCP_TOKEN}'");
    expect(text).toContain("--header 'X-Helm-Session-Id: ${HELM_SESSION_ID}'");
    // A double-quoted placeholder would be expanded by the shell at
    // registration time — the exact macOS bug this guards against.
    expect(text).not.toContain('--header "Authorization: Bearer ${HELM_MCP_TOKEN}"');
  });

  it('double-quotes placeholder-bearing headers on Windows (unchanged)', async () => {
    setPlatform('win32');
    const text = (await mountSetup()).text();

    expect(text).toContain('--header "Authorization: Bearer ${HELM_MCP_TOKEN}"');
    expect(text).toContain('--header "X-Helm-Session-Id: ${HELM_SESSION_ID}"');
  });

  // A session named "Windows verify — artifacts" made `claude mcp add` refuse
  // the whole server: HTTP header values are ISO-8859-1, so the em dash is an
  // invalid value and the CLI drops the connection with
  //   Header 'X-Helm-Session-Name' has invalid value
  // The server resolves the sender's name from the session id, never from this
  // header, so the safe fix is to stop sending a free-text name as a header.
  it('never puts the free-text session name in a header', async () => {
    for (const platform of ['darwin', 'win32'] as NodeJS.Platform[]) {
      setPlatform(platform);
      const text = (await mountSetup()).text();

      expect(text).not.toContain('X-Helm-Session-Name');
      expect(text).not.toContain('HELM_SESSION_NAME');
    }
  });

  it('preserves the placeholder for every MCP client, on both platforms', async () => {
    for (const platform of ['darwin', 'win32'] as NodeJS.Platform[]) {
      setPlatform(platform);
      const text = (await mountSetup()).text();

      // Claude + Copilot carry the placeholder in a quoted header...
      expect(text).toContain('Authorization: Bearer ${HELM_MCP_TOKEN}');
      // ...Codex passes the variable NAME, which needs no quoting at all.
      expect(text).toContain('--bearer-token-env-var HELM_MCP_TOKEN');
    }
  });
});
