import { appClient, attachmentsClient, configClient, contextsClient, deliveryClient, dialogClient, draftsClient, eventsClient, incomingClient, keyboardClient, patternsClient, plansClient, projectsClient, schedulerClient, sessionsClient, systemClient, telegramClient, terminalClient, toolsClient } from './ipc/clients.js';
/**
 * Shared UI helpers used across multiple modules.
 */

import { state } from './state.js';
import { escapeHtmlAttribute } from '../src/utils/html.js';
import { formModal as formModalBridge, setFormModalResolve } from './stores/modal-bridge.js';

export let formModalVisible = false;

const DIRECTION_MAP: Record<string, 'up' | 'down' | 'left' | 'right'> = {
  DPadUp: 'up',
  DPadDown: 'down',
  DPadLeft: 'left',
  DPadRight: 'right',
};

export function toDirection(button: string): 'up' | 'down' | 'left' | 'right' | null {
  return DIRECTION_MAP[button] ?? null;
}

export function logEvent(event: string): void {
  const now = new Date();
  const time = now.toLocaleTimeString('en-US', { hour12: false });
  state.eventLog.unshift({ time, event });
  if (state.eventLog.length > 50) state.eventLog.pop();
  renderEventLog();
}

export function renderEventLog(): void {
  const logEl = document.getElementById('eventLog');
  if (!logEl) return;
  logEl.innerHTML = state.eventLog.slice(0, 20).map(e => `
    <div class="event-log-item">
      <span class="event-log-item--time">[${e.time}]</span> ${e.event}
    </div>
  `).join('');
}

export function showScreen(screenName: string): void {
  document.querySelectorAll('.screen').forEach(s => {
    if (s.id === 'screen-sessions' && screenName === 'settings') return;
    s.classList.remove('screen--active');
  });
  const targetScreen = document.getElementById(`screen-${screenName}`);
  if (targetScreen) {
    targetScreen.classList.add('screen--active');
    state.currentScreen = screenName;
    logEvent(`Screen: ${screenName}`);
  }
}


const CLI_TYPE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Renderer-side mirror of ConfigLoader.resolveCliType — same order, same rules:
 * uuid id → legacy slug → display name. The tools cache is uuid-keyed, but a
 * reference reaching the UI can still be a pre-migration slug or a label a
 * human typed, so all three have to resolve to the same record.
 */
/** Whether this CLI type opted in to xterm mouse tracking (default off so plain drag copies). */
export function cliTypeWantsMouseTracking(cliType: string | undefined): boolean {
  return resolveCliTypeRecord(cliType ?? '')?.mouseTracking === true;
}

export function resolveCliTypeRecord(cliType: string): Record<string, any> | null {
  if (typeof cliType !== 'string') return null;
  const ref = cliType.trim();
  if (!ref) return null;
  const cache = state.cliToolsCache;
  if (!cache) return null;

  const byId = cache[ref];
  if (byId) return byId;

  const entries = Object.entries(cache);
  const byLegacyKey = entries.find(([, record]) => record?.legacyKey === ref);
  if (byLegacyKey) return byLegacyKey[1];

  const wanted = ref.toLowerCase();
  const byName = entries.find(
    ([, record]) => String(record?.displayName ?? record?.name ?? '').trim().toLowerCase() === wanted,
  );
  return byName ? byName[1] : null;
}

/**
 * Renderer-side mirror of the main process's normalizeProjectPath: collapse
 * repeated separators, drop trailing ones, lowercase on Windows. Session
 * workingDir and plan/project paths are stored in this shape, so any renderer
 * comparison against a configured directory path must go through here — a bare
 * `===` silently never matches on Windows.
 *
 * Unlike the main-process version this does not resolve relative paths; every
 * path reaching the renderer is already absolute.
 */
export function normalizeDirPath(input: string): string {
  if (typeof input !== 'string') return '';
  const isWindows = (window as { helmPlatform?: string }).helmPlatform === 'win32';
  const sep = isWindows ? '\\' : '/';
  const collapsed = input.trim().replace(/[\\/]+/g, sep).replace(/[\\/]+$/, '');
  return isWindows ? collapsed.toLowerCase() : collapsed;
}

export function getCliDisplayName(cliType: string): string {
  const record = resolveCliTypeRecord(cliType);
  const label = record?.displayName ?? record?.name;
  if (typeof label === 'string' && label.trim().length > 0) return label.trim();
  // Nothing resolved. A uuid is meaningless to a human and must never reach the
  // screen; any other reference is at least a readable handle, so show it.
  const ref = typeof cliType === 'string' ? cliType.trim() : '';
  if (!ref || CLI_TYPE_UUID_RE.test(ref)) return 'Unknown CLI';
  return ref;
}

export function getFocusableElements(root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.focusable:not([hidden]):not([disabled])'));
}

export function navigateFocus(direction: number, root: ParentNode = document): void {
  const focusable = getFocusableElements(root);
  if (focusable.length === 0) return;
  const currentIndex = focusable.findIndex(el => el === document.activeElement);
  let nextIndex = currentIndex + direction;
  if (nextIndex < 0) nextIndex = focusable.length - 1;
  if (nextIndex >= focusable.length) nextIndex = 0;
  const target = focusable[nextIndex];
  target.focus();
  target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

export function formatBindingDetails(binding: any): string {
  switch (binding.action) {
    case 'keyboard': {
      if (!binding.sequence) return '—';
      const preview = binding.sequence.length > 40 ? binding.sequence.substring(0, 37) + '...' : binding.sequence;
      return `seq: ${preview.replace(/\n/g, '↵')}`;
    }
    case 'voice':
      return binding.key ? `${binding.mode || 'tap'}: ${binding.key}` : '—';
    case 'voice-talk':
      return 'hold: talk to Helm';
    case 'scroll':
      return `scroll: ${binding.direction || 'down'}${binding.lines ? ` (${binding.lines} lines)` : ''}`;
    default:
      return JSON.stringify(binding);
  }
}

export interface FormFieldOption { value: string; label: string; }
export interface FormField {
  key: string;
  label: string;
  defaultValue?: string;
  placeholder?: string;
  type?: 'text' | 'select' | 'textarea' | 'checkbox';
  options?: FormFieldOption[];
  required?: boolean;
  browse?: boolean;
  showLabels?: boolean;
}

export function getRequiredFormFieldError(field: Pick<FormField, 'label' | 'required' | 'type'>, value?: string): string | null {
  if (!field.required) return null;
  if (field.type === 'checkbox') return value === 'true' ? null : `${field.label} is required.`;
  return value?.trim() ? null : `${field.label} is required.`;
}

function folderBasename(folderPath: string): string {
  const parts = folderPath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || parts[parts.length - 2] || '';
}

export function createBrowseButton(pathInput: HTMLInputElement, nameInput?: HTMLInputElement | null): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.textContent = '📁';
  btn.title = 'Browse…';
  btn.type = 'button';
  btn.addEventListener('click', async () => {
    const selected = await dialogClient.dialogOpenFolder();
    if (selected) {
      pathInput.value = selected;
      pathInput.dispatchEvent(new Event('input', { bubbles: true }));
      const nameEl = nameInput ?? document.getElementById('formField_name') as HTMLInputElement | null;
      if (nameEl && !nameEl.value.trim()) nameEl.value = folderBasename(selected);
    }
  });
  return btn;
}

export function showFormModal(title: string, fields: FormField[]): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    formModalBridge.visible = true;
    formModalBridge.title = title;
    formModalBridge.fields = fields.map(f => ({
      key: f.key,
      label: f.label,
      defaultValue: f.defaultValue,
      placeholder: f.placeholder,
      type: f.type,
      options: f.options,
      required: f.required,
      browse: f.browse,
      showLabels: f.showLabels,
    }));
    formModalVisible = true;
    setFormModalResolve((values: Record<string, string> | null) => {
      formModalVisible = false;
      formModalBridge.visible = false;
      resolve(values);
    });
  });
}

export function getSequenceSyntaxHelpText(): string {
  return `SYNTAX REFERENCE

Plain text     → Typed literally. Newlines stay in text.
{Enter}        → Submit using this CLI's submit suffix
{Send}         → Submit using this CLI's submit suffix
{NoSend}       → Suppress the final implied submit
{NoEnter}      → Alias for {NoSend}
{Ctrl+S}       → Key combo
{Ctrl+Shift+P} → Multi-modifier combo
{Ctrl Down}    → Press & hold modifier
{Ctrl Up}      → Release modifier
{Wait 500}     → Pause 500ms
{{ or }}       → Literal { or }

All {tokens} are case-insensitive.

MODIFIERS: Ctrl, Alt, Shift, Win

SPECIAL KEYS: Enter, Send, NoSend, NoEnter, Tab, Esc, Space,
  Backspace, Delete, Insert, Home, End, PageUp, PageDown,
  Up, Down, Left, Right, F1–F12, CapsLock, PrintScreen

EXAMPLE:
  /allow-all{Send}{Wait 3000}prompt text here

NOTE:
  If no {Send}, {Enter}, {NoSend}, or {NoEnter} appears, Helm sends once at the end.`;
}

export function createSequenceSyntaxHelp(): HTMLElement {
  const helpToggle = document.createElement('button');
  helpToggle.type = 'button';
  helpToggle.className = 'sequence-help-toggle focusable';
  helpToggle.textContent = '? Syntax Help';
  helpToggle.tabIndex = 0;

  const helpPanel = document.createElement('div');
  helpPanel.className = 'sequence-help';
  helpPanel.textContent = getSequenceSyntaxHelpText();

  helpToggle.addEventListener('click', () => {
    helpPanel.classList.toggle('sequence-help--visible');
  });

  const container = document.createElement('div');
  container.className = 'sequence-syntax-help-container';
  container.appendChild(helpToggle);
  container.appendChild(helpPanel);
  return container;
}

export function escapeHtml(text: string): string {
  return escapeHtmlAttribute(text);
}
