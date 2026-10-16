<script setup lang="ts">
/**
 * TelegramTab.vue — Telegram bot configuration (connection, security, notifications).
 */
import { ref, watch } from 'vue';

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  allowedUsers: string;
  notificationsEnabled: boolean;
  autoStart: boolean;
}

const props = defineProps<{
  config: TelegramConfig;
  botRunning: boolean;
}>();

const emit = defineEmits<{
  updateField: [field: string, value: string | boolean];
  startBot: [];
  stopBot: [];
}>();

// Local editable copies
const botToken = ref(props.config.botToken);
const chatId = ref(props.config.chatId);
const allowedUsers = ref(props.config.allowedUsers);

// Sync from props when they change externally
watch(() => props.config, (c) => {
  botToken.value = c.botToken;
  chatId.value = c.chatId;
  allowedUsers.value = c.allowedUsers;
});

// Debounced save
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function debouncedEmit(field: string, value: string): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => emit('updateField', field, value), 500);
}

function immediateEmit(field: string, value: string): void {
  if (saveTimer) clearTimeout(saveTimer);
  emit('updateField', field, value);
}
</script>


<template>
  <div class="settings-telegram-panel">
    <section class="telegram-section telegram-setup-guide">
      <details>
        <summary>Setup Guide</summary>
        <ol>
          <li><strong>Create a bot</strong> — Message <code>@BotFather</code>, send <code>/newbot</code>, copy the Bot Token</li>
          <li><strong>Enable forum topics</strong> — Group settings &rarr; Topics &rarr; Enable Topics; add bot as admin with "Manage Topics" permission</li>
          <li><strong>Get Chat ID</strong> — Add <code>@userinfobot</code> to your group &rarr; it posts the group ID (negative number like <code>-1001234567890</code>)</li>
          <li><strong>Get your User ID</strong> — DM <code>@userinfobot</code> &rarr; copy your ID &rarr; paste into Allowed Users</li>
          <li><strong>Start bot</strong> — Fill in the fields above, click Start Bot &rarr; status turns green</li>
          <li><strong>Test</strong> — In your group type <code>/start</code>; from a CLI session call <code>telegram_chat</code> MCP tool</li>
        </ol>
      </details>
    </section>

    <section class="telegram-section">
      <h4>Connection</h4>
      <label class="telegram-field">
        Bot Token
        <input
          v-model="botToken"
          type="password"
          placeholder="Enter bot token..."
          @input="debouncedEmit('botToken', botToken)"
          @blur="immediateEmit('botToken', botToken)"
        />
      </label>
      <label class="telegram-field">
        Chat ID
        <input
          v-model="chatId"
          type="text"
          placeholder="Enter chat ID..."
          @input="debouncedEmit('chatId', chatId)"
          @blur="immediateEmit('chatId', chatId)"
        />
      </label>
    </section>

    <section class="telegram-section">
      <h4>Security</h4>
      <label class="telegram-field">
        Allowed Users (comma-separated)
        <input
          v-model="allowedUsers"
          type="text"
          placeholder="user1, user2"
          @input="debouncedEmit('allowedUsers', allowedUsers)"
          @blur="immediateEmit('allowedUsers', allowedUsers)"
        />
      </label>
    </section>

    <section class="telegram-section">
      <h4>Notifications</h4>
      <label class="notification-toggle">
        <input
          type="checkbox"
          :checked="config.notificationsEnabled"
          @change="emit('updateField', 'notificationsEnabled', ($event.target as HTMLInputElement).checked)"
        />
        Enable Telegram notifications
      </label>
    </section>

    <section class="telegram-section">
      <h4>Startup</h4>
      <label class="notification-toggle">
        <input
          type="checkbox"
          :checked="config.autoStart"
          @change="emit('updateField', 'autoStart', ($event.target as HTMLInputElement).checked)"
        />
        Auto-start bot 60 seconds after launch
      </label>
    </section>

    <section class="telegram-section">
      <h4>Bot Control</h4>
      <div class="bot-status">
        <span :class="botRunning ? 'bot-running' : 'bot-stopped'">
          {{ botRunning ? '🟢 Running' : '⚪ Stopped' }}
        </span>
        <button
          v-if="!botRunning"
          class="focusable"
          @click="emit('startBot')"
        >
          Start Bot
        </button>
        <button
          v-else
          class="focusable danger"
          @click="emit('stopBot')"
        >
          Stop Bot
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.telegram-section {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) 0;
  border-bottom: 1px solid var(--border);
}

.telegram-section:last-child {
  border-bottom: none;
}

.telegram-section h4 {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.telegram-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.telegram-field input {
  width: 100%;
  padding: 6px 8px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  font-family: inherit;
}

.telegram-field input:focus {
  outline: none;
  border-color: var(--accent);
}

.bot-status {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
}

.bot-running {
  color: #44cc44;
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.bot-stopped {
  color: var(--text-dim);
  font-size: var(--font-size-sm);
  font-weight: 600;
}
</style>

<style scoped>
.telegram-setup-guide summary {
  cursor: pointer;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-size: var(--font-size-sm);
  padding: var(--spacing-xs) 0;
}

.telegram-setup-guide ol {
  margin: var(--spacing-xs) 0 0 0;
  padding-left: 1.5em;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  color: var(--text-primary);
  font-size: var(--font-size-xs);
  line-height: 1.5;
}

.telegram-setup-guide code {
  background: var(--bg-tertiary);
  padding: 0.1em 0.3em;
  border-radius: 3px;
  font-size: inherit;
}

</style>
