<script setup lang="ts">
import { appClient, attachmentsClient, configClient, contextsClient, deliveryClient, dialogClient, eventsClient, incomingClient, keyboardClient, patternsClient, plansClient, projectsClient, schedulerClient, sessionsClient, systemClient, telegramClient, terminalClient, toolsClient } from '../../../ipc/clients.js';
/**
 * McpCliSetup.vue — Extracts Global CLI Setup section from McpTab.vue
 * with env var awareness, copy button, and a run-in-shell button per snippet.
 * Snippets and the run button are OS-dependent: cmd.exe syntax on Windows,
 * POSIX syntax on macOS/Linux (the PTY default shell there) — so the emitted
 * command actually runs in whatever shell doSpawnShell() opens.
 *
 * Every snippet must ALSO keep `${HELM_MCP_TOKEN}` unexpanded through
 * registration; see quoteArg() below for why that differs per shell.
 */
import { ref, computed, onMounted } from 'vue';
import { isWindows as detectWindows, getPlatform } from '../../../utils/platform.js';

const isWindows = detectWindows();
const shellName = isWindows ? 'cmd.exe' : (getPlatform() === 'darwin' ? 'zsh' : 'bash');
const runLabel = `Run in ${shellName}`;

/**
 * Quote a CLI argument so `${HELM_MCP_TOKEN}`-style placeholders survive
 * REGISTRATION UNEXPANDED and land literally in the client's config file.
 *
 * This is the whole reason MCP setup worked on Windows but not macOS: cmd.exe
 * has no `${...}` syntax, so double-quoted placeholders were stored verbatim
 * and the client expanded them per-launch from the PTY env that
 * resolveConfiguredSpawnEnv() injects — giving each session its own minted,
 * session-scoped token. POSIX shells expand `${...}` at registration time, so
 * the config froze one session's token forever and every later session got a
 * 401. Single quotes on POSIX restore the Windows semantics exactly.
 */
function quoteArg(text: string): string {
  if (isWindows) return `"${text}"`;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

const props = defineProps<{
  endpoint: string;
  tokenLiteral: string;
}>();

const emit = defineEmits<{
  'run-in-shell': [command: string];
}>();

const useEnvVar = ref(true);
const cliEnvs = ref(new Map<string, Array<{ name: string; value: string }>>());

onMounted(async () => {
  try {
    const cliTypes = await configClient.configGetCliTypes();
    for (const cliType of cliTypes) {
      const env = await configClient.configGetCliTypeEnv(cliType);
      cliEnvs.value.set(cliType, env || []);
    }
  } catch (error) {
    console.error('[McpCliSetup] Failed to load CLI env vars:', error);
  }
});

function envForCli(...keys: string[]): Array<{ name: string; value: string }> {
  for (const key of keys) {
    const env = cliEnvs.value.get(key);
    if (env && env.length > 0) return env;
  }
  return [];
}

function envSetupLines(entries: Array<{ name: string; value: string }>): string {
  const keyword = isWindows ? 'set ' : 'export ';
  return entries.map((e) => `${keyword}${e.name}=${e.value}`).join('\n');
}

const codexEnv = computed(() => envForCli('codex'));
const codexSetup = computed(() => {
  const env = envSetupLines(codexEnv.value);
  // --bearer-token-env-var passes a variable NAME, so it is inherently
  // shell-safe and resolves per-launch on every platform. The literal branch
  // bakes in the base token, which the server treats as anonymous read-only.
  const cmd = useEnvVar.value
    ? `codex mcp add helm --url ${props.endpoint} --bearer-token-env-var HELM_MCP_TOKEN`
    : `codex mcp add helm --url ${props.endpoint} --bearer-token ${quoteArg(props.tokenLiteral)}`;
  return env ? `${env}\n${cmd}` : cmd;
});

const claudeEnv = computed(() => envForCli('claude', 'claude-code'));
const claudeSetup = computed(() => {
  const env = envSetupLines(claudeEnv.value);
  // No X-Helm-Session-Name header, deliberately. Session names are free text and
  // HTTP header values are ISO-8859-1, so one em dash or emoji in a name makes
  // `claude mcp add` reject the whole server ("has invalid value") and the CLI
  // silently loses every Helm tool. The server resolves the sender's name from
  // X-Helm-Session-Id and never reads a name header, so nothing is lost.
  const headers = [
    'Authorization: Bearer ${HELM_MCP_TOKEN}',
    'X-Helm-Session-Id: ${HELM_SESSION_ID}',
  ].map(h => `--header ${quoteArg(h)}`).join(' ');
  const cmd = `claude mcp add --transport http --scope user helm ${props.endpoint} ${headers}`;
  return env ? `${env}\n${cmd}` : cmd;
});

const copilotEnv = computed(() => envForCli('copilot', 'copilot-cli'));
const copilotSetup = computed(() => {
  const env = envSetupLines(copilotEnv.value);
  const bearer = useEnvVar.value ? '${HELM_MCP_TOKEN}' : props.tokenLiteral;
  const cmd = `copilot mcp add --transport http helm ${props.endpoint} --header ${quoteArg(`Authorization: Bearer ${bearer}`)}`;
  return env ? `${env}\n${cmd}` : cmd;
});

const opencodeEnv = computed(() => envForCli('opencode'));
const opencodeSetup = computed(() => {
  const env = envSetupLines(opencodeEnv.value);
  const json = JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      helm: {
        type: 'remote',
        url: props.endpoint,
        enabled: true,
        headers: { Authorization: `Bearer ${props.tokenLiteral}` },
      },
    },
  });
  let cmd: string;
  if (isWindows) {
    const configDir = '%USERPROFILE%\\.config\\opencode';
    cmd = [
      `if not exist "${configDir}" mkdir "${configDir}"`,
      `powershell -Command "Set-Content -Path '${configDir}\\opencode.json' -Value '${json.replace(/'/g, "''")}'"`,
    ].join('\n');
  } else {
    // Quoted heredoc delimiter → no shell expansion/escaping of the JSON body.
    const configDir = '$HOME/.config/opencode';
    cmd = [
      `mkdir -p "${configDir}"`,
      `cat > "${configDir}/opencode.json" <<'HELM_EOF'`,
      json,
      'HELM_EOF',
    ].join('\n');
  }
  return env ? `${env}\n${cmd}` : cmd;
});

function copySnippet(text: string): void {
  navigator.clipboard.writeText(text);
}

function onRunInShell(command: string): void {
  emit('run-in-shell', command);
}
</script>

<template>
  <div class="tg-section">
    <h3 class="tg-section-title">Global CLI Setup</h3>
    <div class="tg-form-row">
      <label class="tg-label">Codex: use env var</label>
      <input
        v-model="useEnvVar"
        type="checkbox"
        class="focusable"
      />
    </div>
    <p class="settings-form__hint">
      All commands use {{ shellName }} syntax. Run them in your terminal to register Helm as an MCP.
      The <code>${{ '{' }}HELM_MCP_TOKEN{{ '}' }}</code> placeholder is stored as-is and resolved per session at launch — do not substitute it by hand.
    </p>

    <div class="settings-list-item">
      <div class="settings-list-item__info">
        <span class="settings-list-item__name">Codex setup</span>
        <pre class="mcp-command-block">{{ codexSetup }}</pre>
        <div class="mcp-snippet-actions">
          <button class="btn btn--secondary btn--sm focusable" @click="copySnippet(codexSetup)">
            Copy
          </button>
          <button class="btn btn--secondary btn--sm focusable" @click="onRunInShell(codexSetup)">
            {{ runLabel }}
          </button>
        </div>
      </div>
    </div>

    <div class="settings-list-item">
      <div class="settings-list-item__info">
        <span class="settings-list-item__name">Claude Code setup</span>
        <pre class="mcp-command-block">{{ claudeSetup }}</pre>
        <div class="mcp-snippet-actions">
          <button class="btn btn--secondary btn--sm focusable" @click="copySnippet(claudeSetup)">
            Copy
          </button>
          <button class="btn btn--secondary btn--sm focusable" @click="onRunInShell(claudeSetup)">
            {{ runLabel }}
          </button>
        </div>
      </div>
    </div>

    <div class="settings-list-item">
      <div class="settings-list-item__info">
        <span class="settings-list-item__name">Copilot CLI setup</span>
        <pre class="mcp-command-block">{{ copilotSetup }}</pre>
        <div class="mcp-snippet-actions">
          <button class="btn btn--secondary btn--sm focusable" @click="copySnippet(copilotSetup)">
            Copy
          </button>
          <button class="btn btn--secondary btn--sm focusable" @click="onRunInShell(copilotSetup)">
            {{ runLabel }}
          </button>
        </div>
      </div>
    </div>

    <div class="settings-list-item">
      <div class="settings-list-item__info">
        <span class="settings-list-item__name">OpenCode setup ⚠️ experimental — not actively tested</span>
        <pre class="mcp-command-block">{{ opencodeSetup }}</pre>
        <div class="mcp-snippet-actions">
          <button class="btn btn--secondary btn--sm focusable" @click="copySnippet(opencodeSetup)">
            Copy
          </button>
          <button class="btn btn--secondary btn--sm focusable" @click="onRunInShell(opencodeSetup)">
            {{ runLabel }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mcp-command-block {
  margin: 8px 0 0;
  padding: 10px 12px;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono, "Cascadia Code", "Fira Code", monospace);
  font-size: var(--font-size-sm);
  line-height: 1.45;
}

.mcp-snippet-actions {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}
</style>
