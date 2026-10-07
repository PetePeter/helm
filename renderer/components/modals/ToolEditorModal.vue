<script setup lang="ts">
import { DEFAULT_CACHE_EXPIRE_MINUTES, DEFAULT_CACHE_WARN_MINUTES } from '../../../src/session/prompt-staleness.js';
import { HEARTBEAT_CLOSE, HEARTBEAT_OPEN, KEEP_WARM_DEFAULT_TEXT } from '../../../src/session/keep-warm-prompt.js';
/**
 * Tool editor modal — purpose-built form for adding/editing CLI Type tool
 * configurations. Replaces the generic FormModal with a structured layout
 * featuring grouped sections and two-column fields.
 */
import { ref, watch, computed } from 'vue';
import { FORM_KEYS, useModalStack } from '../../composables/useModalStack.js';
import { useFocusTrap } from '../../composables/useFocusTrap.js';
import PromptTextarea from '../common/PromptTextarea.vue';
import { toolsClient } from '../../ipc/clients.js';
import type { ToolEditorApiConfig, ToolEditorComfyUiConfig } from '../../stores/modal-bridge.js';
import { cloneDefaultComfyUiConfig } from '../../../src/session/comfyui/comfyui-config.js';

const MODAL_ID = 'tool-editor-modal';
const HELM_AUTOFILLED_ENV_ITEMS = [
  { name: 'HELM_MCP_TOKEN', value: '<autofilled by helm>' },
  { name: 'HELM_SESSION_ID', value: '<autofilled by helm>' },
  { name: 'HELM_SESSION_NAME', value: '<autofilled by helm>' },
] as const;
const HELM_AUTOFILLED_ENV_NAMES = new Set(HELM_AUTOFILLED_ENV_ITEMS.map((item) => item.name));
const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8080/v1';
const DEFAULT_MAX_TOOL_ROUNDS = 25;
type ApiToolCatalogItem = { name: string; description: string; source: 'native' | 'helm' };
const SUBMIT_SUFFIX_OPTIONS = [
  { label: 'Carriage Return (CR / \\r)', value: '\\r' },
  { label: 'Line Feed (LF / \\n)', value: '\\n' },
  { label: 'Both (CRLF / \\r\\n)', value: '\\r\\n' },
] as const;
type SubmitSuffixOption = typeof SUBMIT_SUFFIX_OPTIONS[number]['value'];

function normalizeSubmitSuffix(value?: string): SubmitSuffixOption {
  if (value === '\\n' || value === '\n') return '\\n';
  if (value === '\\r\\n' || value === '\r\n') return '\\r\\n';
  return '\\r';
}

export interface ToolEditorData {
  api?: ToolEditorApiConfig | null;
  comfyUi?: ToolEditorComfyUiConfig | null;
  name: string;
  env: Array<{ name: string; value: string; mode?: 'replace' | 'append' | 'prepend' }>;
  initialPromptDelay: number;
  spawnCommand: string;
  resumeCommand: string;
  continueCommand: string;
  renameCommand: string;
  helmPreambleForInterSession?: boolean;
  largeTextAsTempFile: boolean;
  messReminders?: boolean;
  cacheWarnMinutes?: number;
  cacheExpireMinutes?: number;
  noPromptCache?: boolean;
  keepWarmPrompt?: string;
  mouseTracking?: boolean;
  bindingProfileId?: string;
  submitSuffix: string;
  helmActions: { clear: string; compact: string; export: string };
  initialPrompt: Array<{ label: string; sequence: string }>;
}

const props = defineProps<{
  visible: boolean;
  mode: 'add' | 'edit' | 'clone';
  editKey: string;
  initialData: ToolEditorData;
  /** Binding profiles the tool can point at; '' in the picker means none. */
  bindingProfiles?: Array<{ id: string; name: string }>;
  /** Returns an error message when the name is not usable, or null when it is. */
  validateName?: (name: string) => string | null;
}>();

const emit = defineEmits<{
  (e: 'save', values: {
    name: string;
    env: Array<{ name: string; value: string; mode?: 'replace' | 'append' | 'prepend' }>;
    initialPromptDelay: number;
    spawnCommand: string;
    resumeCommand: string;
    continueCommand: string;
    renameCommand: string;
    helmPreambleForInterSession?: boolean;
    largeTextAsTempFile: boolean;
    messReminders?: boolean;
    cacheWarnMinutes?: number;
    cacheExpireMinutes?: number;
    noPromptCache?: boolean;
    keepWarmPrompt: string;
    mouseTracking?: boolean;
    bindingProfileId: string;
    submitSuffix: string;
    helmActions: { clear: string; compact: string; export: string };
    _promptItems: Array<{ label: string; sequence: string }>;
    api: ToolEditorApiConfig | null;
    comfyUi: ToolEditorComfyUiConfig | null;
  }): void;
  (e: 'cancel'): void;
  (e: 'update:visible', value: boolean): void;
}>();

const name = ref('');
const nameError = ref<string | null>(null);
type EnvItem = { id: number; name: string; value: string; mode: 'replace' | 'append' | 'prepend' };
const envItems = ref<EnvItem[]>([]);
const initialPromptDelay = ref(2000);
const spawnCommand = ref('');
const resumeCommand = ref('');
const continueCommand = ref('');
const renameCommand = ref('');
const helmPreambleForInterSession = ref(true);
const largeTextAsTempFile = ref(false);
const messReminders = ref(true);
const cacheWarnMinutes = ref(DEFAULT_CACHE_WARN_MINUTES);
const cacheExpireMinutes = ref(DEFAULT_CACHE_EXPIRE_MINUTES);
const mouseTracking = ref(false);
const noPromptCache = ref(false);
const keepWarmPrompt = ref('');
const bindingProfileId = ref('');
const submitSuffix = ref<SubmitSuffixOption>('\\r');
const helmActionClear = ref('');
const helmActionCompact = ref('');
const helmActionExport = ref('');

// API tool: Helm runs the agent loop itself; no spawn/resume commands apply.
const toolKind = ref<'cli' | 'api' | 'comfyui'>('cli');
const apiBaseUrl = ref(DEFAULT_API_BASE_URL);
const apiModel = ref('');
const apiKeyEnv = ref('');
const apiMaxToolRounds = ref(DEFAULT_MAX_TOOL_ROUNDS);
const apiSlots = ref(1);
const apiSystemPrompt = ref('');
const apiAllowed = ref<Set<string>>(new Set());
const apiCatalog = ref<ApiToolCatalogItem[]>([]);
const apiCatalogGroups = computed(() => ([
  { source: 'native' as const, label: 'Native', tools: apiCatalog.value.filter(t => t.source === 'native') },
  { source: 'helm' as const, label: 'Helm', tools: apiCatalog.value.filter(t => t.source === 'helm') },
]));
const comfyUi = ref<ToolEditorComfyUiConfig>(cloneDefaultComfyUiConfig());
const comfyProfileId = ref('image');
const comfyProfileName = ref('Image');
const comfyProfileKind = ref<'image' | 'video'>('image');
const comfyWorkflowJson = ref('');
const comfyMappingsJson = ref('');
const comfyDefaultsJson = ref('');
const comfyOutputNodeIds = ref('');
const comfyError = ref('');

function loadComfyProfile(profileId = comfyProfileId.value): void {
  const profile = comfyUi.value.profiles.find(item => item.id === profileId);
  if (!profile) return;
  comfyProfileId.value = profile.id;
  comfyProfileName.value = profile.name;
  comfyProfileKind.value = profile.kind;
  comfyWorkflowJson.value = JSON.stringify(profile.workflow, null, 2);
  comfyMappingsJson.value = JSON.stringify(profile.mappings, null, 2);
  comfyDefaultsJson.value = JSON.stringify(profile.defaults ?? {}, null, 2);
  comfyOutputNodeIds.value = profile.outputNodeIds.join(', ');
  comfyError.value = '';
}

function commitComfyProfile(): boolean {
  try {
    const workflow = JSON.parse(comfyWorkflowJson.value) as Record<string, unknown>;
    const mappings = JSON.parse(comfyMappingsJson.value) as Record<string, { nodeId: string; input: string }>;
    const defaults = JSON.parse(comfyDefaultsJson.value) as Record<string, string | number>;
    if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) throw new Error('Workflow must be an object');
    if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings)) throw new Error('Mappings must be an object');
    if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) throw new Error('Defaults must be an object');
    const profile = {
      id: comfyProfileId.value,
      name: comfyProfileName.value.trim(),
      kind: comfyProfileKind.value,
      workflow,
      mappings,
      defaults,
      outputNodeIds: comfyOutputNodeIds.value.split(',').map(id => id.trim()).filter(Boolean),
    };
    if (!profile.name) throw new Error('Profile name is required');
    comfyUi.value = {
      ...comfyUi.value,
      endpoint: comfyUi.value.endpoint.trim(),
      profiles: comfyUi.value.profiles.map(item => item.id === profile.id ? profile : item),
    };
    comfyError.value = '';
    return true;
  } catch (error) {
    comfyError.value = error instanceof Error ? error.message : String(error);
    return false;
  }
}

function selectComfyProfile(event: Event): void {
  if (!commitComfyProfile()) return;
  loadComfyProfile((event.target as HTMLSelectElement).value);
}

function addComfyProfile(): void {
  if (!commitComfyProfile()) return;
  const id = `custom-${Date.now()}`;
  comfyUi.value.profiles.push({ id, name: 'Custom profile', kind: 'image', workflow: {}, mappings: {}, outputNodeIds: [] });
  loadComfyProfile(id);
}

function importComfyWorkflow(): void {
  try {
    const parsed = JSON.parse(comfyWorkflowJson.value) as Record<string, unknown>;
    const graph = parsed.prompt && typeof parsed.prompt === 'object' ? parsed.prompt : parsed;
    if (!graph || typeof graph !== 'object' || Array.isArray(graph)) throw new Error('Expected a ComfyUI API workflow object');
    comfyWorkflowJson.value = JSON.stringify(graph, null, 2);
    comfyError.value = '';
  } catch (error) {
    comfyError.value = error instanceof Error ? error.message : String(error);
  }
}

async function loadApiCatalog(): Promise<void> {
  try {
    apiCatalog.value = await toolsClient.toolsApiToolCatalog();
  } catch (error) {
    console.error('Failed to load API tool catalog:', error);
    apiCatalog.value = [];
  }
}

function toggleApiTool(toolName: string, on: boolean): void {
  const next = new Set(apiAllowed.value);
  if (on) next.add(toolName); else next.delete(toolName);
  apiAllowed.value = next;
}

function setApiGroup(source: 'native' | 'helm', on: boolean): void {
  const next = new Set(apiAllowed.value);
  for (const tool of apiCatalog.value) {
    if (tool.source !== source) continue;
    if (on) next.add(tool.name); else next.delete(tool.name);
  }
  apiAllowed.value = next;
}

interface SeqItem { label: string; sequence: string }
const promptItems = ref<SeqItem[]>([]);

const overlayRef = ref<HTMLElement | null>(null);
const { onKeydown } = useFocusTrap(overlayRef);
let nextEnvId = 1;

// The display name is the handle — the uuid identity never belongs in a title.
const title = computed(() => {
  const handle = props.initialData?.name?.trim() || 'CLI Type';
  if (props.mode === 'add') return 'Add CLI Type';
  return props.mode === 'clone' ? `Clone CLI Type: ${handle}` : `Edit CLI Type: ${handle}`;
});

const modalStack = useModalStack();

watch(() => props.visible, (v) => {
  if (v) {
    initForm();
    void loadApiCatalog();
    modalStack.push({ id: MODAL_ID, handler: handleButton, interceptKeys: FORM_KEYS });
  } else {
    modalStack.pop(MODAL_ID);
  }
}, { immediate: true });

function handleButton(button: string): boolean {
  if (button === 'B') {
    emit('cancel');
    emit('update:visible', false);
    return true;
  }
  return true;
}

function initForm(): void {
  const d = props.initialData;
  name.value = d.name ?? '';
  nameError.value = null;
  envItems.value = Array.isArray(d.env)
    ? d.env.map(item => ({
        id: nextEnvId++,
        name: typeof item?.name === 'string' ? item.name : '',
        value: typeof item?.value === 'string' ? item.value : '',
        mode: (item.mode === 'append' || item.mode === 'prepend') ? item.mode : 'replace',
      }))
        .filter((item) => !HELM_AUTOFILLED_ENV_NAMES.has(item.name.trim()))
    : [];
  initialPromptDelay.value = d.initialPromptDelay ?? 2000;
  spawnCommand.value = d.spawnCommand ?? '';
  resumeCommand.value = d.resumeCommand ?? '';
  continueCommand.value = d.continueCommand ?? '';
  renameCommand.value = d.renameCommand ?? '';
  helmPreambleForInterSession.value = d.helmPreambleForInterSession !== false;
  largeTextAsTempFile.value = Boolean(d.largeTextAsTempFile);
  messReminders.value = d.messReminders !== false;
  cacheWarnMinutes.value = d.cacheWarnMinutes || DEFAULT_CACHE_WARN_MINUTES;
  cacheExpireMinutes.value = d.cacheExpireMinutes || DEFAULT_CACHE_EXPIRE_MINUTES;
  mouseTracking.value = Boolean(d.mouseTracking);
  noPromptCache.value = Boolean(d.noPromptCache);
  keepWarmPrompt.value = d.keepWarmPrompt ?? '';
  bindingProfileId.value = d.bindingProfileId ?? '';
  submitSuffix.value = normalizeSubmitSuffix(d.submitSuffix);
  helmActionClear.value = d.helmActions?.clear ?? '';
  helmActionCompact.value = d.helmActions?.compact ?? '';
  helmActionExport.value = d.helmActions?.export ?? '';
  toolKind.value = d.comfyUi ? 'comfyui' : d.api ? 'api' : 'cli';
  apiBaseUrl.value = d.api?.baseUrl || DEFAULT_API_BASE_URL;
  apiModel.value = d.api?.model ?? '';
  apiKeyEnv.value = d.api?.apiKeyEnv ?? '';
  apiMaxToolRounds.value = d.api?.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
  apiSlots.value = d.api?.slots ?? 1;
  apiSystemPrompt.value = d.api?.systemPrompt ?? '';
  apiAllowed.value = new Set(d.api?.allowedTools ?? []);
  comfyUi.value = structuredClone(d.comfyUi ?? cloneDefaultComfyUiConfig());
  comfyProfileId.value = comfyUi.value.profiles[0]?.id ?? '';
  loadComfyProfile();
  promptItems.value = Array.isArray(d.initialPrompt)
    ? d.initialPrompt.map(item => ({
        label: typeof item?.label === 'string' ? item.label : '',
        sequence: typeof item?.sequence === 'string' ? item.sequence : '',
      }))
    : [];
}

const HELM_INIT_PROMPT = {
  label: 'Helm session init',
  sequence: 'Call session_info to get Helm MCP initial information.{Enter}',
};

function addPromptItem(): void {
  promptItems.value.push({ label: '', sequence: '' });
}

function addHelmInitPromptItem(): void {
  promptItems.value.push({ ...HELM_INIT_PROMPT });
}

function removePromptItem(index: number): void {
  promptItems.value.splice(index, 1);
}

function addEnvItem(): void {
  envItems.value.push({ id: nextEnvId++, name: '', value: '', mode: 'replace' });
}

function removeEnvItem(index: number): void {
  envItems.value.splice(index, 1);
}

function onSave(): void {
  // Validate before emitting: the host closes the modal on save, so a rejected
  // name has to stop here or the user loses the form and never sees why.
  nameError.value = props.validateName?.(name.value) ?? null;
  if (nameError.value) return;
  if (toolKind.value === 'comfyui') {
    if (!commitComfyProfile()) return;
    try {
      const endpoint = new URL(comfyUi.value.endpoint);
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('Use an HTTP or HTTPS endpoint without embedded credentials');
    } catch (error) {
      comfyError.value = error instanceof Error ? error.message : 'Invalid ComfyUI endpoint';
      return;
    }
  }

  emit('save', {
    name: name.value,
    env: envItems.value.map(item => ({
      name: item.name,
      value: item.value,
      ...(item.mode !== 'replace' ? { mode: item.mode } : {}),
    })),
    initialPromptDelay: initialPromptDelay.value,
    spawnCommand: spawnCommand.value,
    resumeCommand: resumeCommand.value,
    continueCommand: continueCommand.value,
    renameCommand: renameCommand.value,
    ...(helmPreambleForInterSession.value !== true ? { helmPreambleForInterSession: helmPreambleForInterSession.value } : {}),
    largeTextAsTempFile: largeTextAsTempFile.value,
    ...(messReminders.value !== true ? { messReminders: messReminders.value } : {}),
    cacheWarnMinutes: cacheWarnMinutes.value,
    cacheExpireMinutes: cacheExpireMinutes.value,
    mouseTracking: mouseTracking.value,
    noPromptCache: noPromptCache.value,
    keepWarmPrompt: keepWarmPrompt.value,
    bindingProfileId: bindingProfileId.value,
    submitSuffix: submitSuffix.value,
    helmActions: {
      clear: helmActionClear.value.trim(),
      compact: helmActionCompact.value.trim(),
      export: helmActionExport.value.trim(),
    },
    _promptItems: promptItems.value.map(i => ({ label: i.label, sequence: i.sequence })),
    api: toolKind.value === 'api'
      ? {
          baseUrl: apiBaseUrl.value,
          model: apiModel.value,
          apiKeyEnv: apiKeyEnv.value,
          // Catalog order keeps the saved list stable however the ticks were clicked.
          allowedTools: [
            ...apiCatalog.value.map(t => t.name).filter(n => apiAllowed.value.has(n)),
            ...[...apiAllowed.value].filter(n => !apiCatalog.value.some(t => t.name === n)),
          ],
          systemPrompt: apiSystemPrompt.value,
          maxToolRounds: apiMaxToolRounds.value,
          slots: apiSlots.value,
        }
      : null,
    comfyUi: toolKind.value === 'comfyui' ? comfyUi.value : null,
  });
  emit('update:visible', false);
}

function onCancel(): void {
  emit('cancel');
  emit('update:visible', false);
}

defineExpose({ handleButton });
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="overlayRef"
      class="modal-overlay modal--visible"
      role="dialog"
      :aria-label="title"
      @keydown="onKeydown"
    >
      <div class="modal tool-editor-modal">
        <div class="modal-header">
          <h3 class="modal-title">{{ title }}</h3>
          <button class="te-close-btn" title="Close" @click="onCancel">✕</button>
        </div>

        <div class="modal-body">
          <fieldset class="te-section">
            <legend class="te-section__legend">Basic</legend>
            <div class="te-field">
              <label for="te-name">Name</label>
              <input id="te-name" v-model="name" type="text" placeholder="e.g. Claude Code" class="te-input" />
            </div>
            <p v-if="nameError" class="te-error">{{ nameError }}</p>
            <p v-if="mode !== 'add' && editKey" class="te-identity">id: {{ editKey }}</p>
            <div class="te-field">
              <label for="te-kind">Type</label>
              <select id="te-kind" v-model="toolKind" class="te-select focusable">
                <option value="cli">CLI (spawned in a terminal)</option>
                <option value="api">API tool (Helm runs the model)</option>
                <option value="comfyui">ComfyUI (image and video generation)</option>
              </select>
              <p v-if="toolKind === 'api'" class="te-section__hint">An API tool talks to an OpenAI-compatible endpoint directly. Helm runs the agent loop, the ticked tools and the chat reply itself.</p>
            </div>
          </fieldset>

          <fieldset v-if="toolKind === 'comfyui'" class="te-section">
            <legend class="te-section__legend">ComfyUI</legend>
            <div class="te-field">
              <label for="te-comfy-endpoint">Server endpoint</label>
              <input id="te-comfy-endpoint" v-model="comfyUi.endpoint" type="url" placeholder="http://127.0.0.1:8188" class="te-input te-input--mono focusable" />
            </div>
            <div class="te-grid-2col">
              <div class="te-field">
                <label for="te-comfy-profile">Profile</label>
                <select id="te-comfy-profile" :value="comfyProfileId" class="te-select focusable" @change="selectComfyProfile">
                  <option v-for="profile in comfyUi.profiles" :key="profile.id" :value="profile.id">{{ profile.name }} · {{ profile.kind }}</option>
                </select>
              </div>
              <div class="te-field"><label for="te-comfy-name">Profile name</label><input id="te-comfy-name" v-model="comfyProfileName" class="te-input focusable" /></div>
              <div class="te-field">
                <label for="te-comfy-kind">Media kind</label>
                <select id="te-comfy-kind" v-model="comfyProfileKind" class="te-select focusable"><option value="image">Image</option><option value="video">Video</option></select>
              </div>
              <div class="te-field te-comfy-actions">
                <span>API workflow</span>
                <button type="button" class="btn btn--sm btn--secondary focusable" @click="importComfyWorkflow">Import pasted JSON</button>
                <button type="button" class="btn btn--sm btn--secondary focusable" @click="addComfyProfile">Add profile</button>
              </div>
            </div>
            <p class="te-section__hint">Paste a ComfyUI “Save (API Format)” graph, then map the prompt and output nodes below. Graph editing stays in ComfyUI.</p>
            <div class="te-field">
              <label for="te-comfy-workflow">API workflow JSON</label>
              <textarea id="te-comfy-workflow" v-model="comfyWorkflowJson" rows="10" class="te-input te-input--mono focusable"></textarea>
            </div>
            <div class="te-field">
              <label for="te-comfy-mappings">Input mappings JSON</label>
              <textarea id="te-comfy-mappings" v-model="comfyMappingsJson" rows="4" class="te-input te-input--mono focusable" placeholder="{ &quot;prompt&quot;: { &quot;nodeId&quot;: &quot;2&quot;, &quot;input&quot;: &quot;text&quot; } }"></textarea>
              <p class="te-section__hint">Map prompt, negativePrompt, width, height, steps, cfg, seed, length and fps to { nodeId, input }.</p>
            </div>
            <div class="te-grid-2col">
              <div class="te-field"><label for="te-comfy-defaults">Mapped defaults JSON</label><textarea id="te-comfy-defaults" v-model="comfyDefaultsJson" rows="3" class="te-input te-input--mono focusable" placeholder="{ &quot;width&quot;: 512, &quot;height&quot;: 512 }"></textarea></div>
              <div class="te-field"><label for="te-comfy-outputs">Output node IDs</label><input id="te-comfy-outputs" v-model="comfyOutputNodeIds" class="te-input te-input--mono focusable" placeholder="7, 11" /></div>
            </div>
            <p v-if="comfyError" class="te-error" role="alert">{{ comfyError }}</p>
          </fieldset>

          <fieldset v-if="toolKind === 'api'" class="te-section">
            <legend class="te-section__legend">API</legend>
            <div class="te-grid-2col">
              <div class="te-field"><label for="te-api-url">Base URL</label><input id="te-api-url" v-model="apiBaseUrl" type="text" :placeholder="DEFAULT_API_BASE_URL" class="te-input te-input--mono focusable" /></div>
              <div class="te-field"><label for="te-api-model">Model</label><input id="te-api-model" v-model="apiModel" type="text" placeholder="e.g. minicpm" class="te-input te-input--mono focusable" /></div>
              <div class="te-field"><label for="te-api-key">API key env var</label><input id="te-api-key" v-model="apiKeyEnv" type="text" placeholder="e.g. OPENROUTER_API_KEY" class="te-input te-input--mono focusable" /></div>
              <div class="te-field"><label for="te-api-rounds">Max tool rounds</label><input id="te-api-rounds" v-model.number="apiMaxToolRounds" type="number" min="1" step="1" class="te-input focusable" /></div>
              <div class="te-field"><label for="te-api-slots">Slots</label><input id="te-api-slots" v-model.number="apiSlots" type="number" min="1" step="1" class="te-input focusable" /></div>
            </div>
            <p class="te-section__hint">Slots: model requests in flight at once (match the server's parallel slots). Subagents queue for a free slot.</p>
            <p class="te-section__hint">Only the variable name is stored; Helm reads the key from the environment at spawn.</p>
            <div class="te-field">
              <label for="te-api-system">Extra system prompt</label>
              <textarea id="te-api-system" v-model="apiSystemPrompt" rows="3" class="te-input focusable" placeholder="Appended to Helm's built-in instructions"></textarea>
            </div>
            <div v-for="group in apiCatalogGroups" :key="group.source" class="te-api-group">
              <div class="te-api-group__header">
                <span class="te-api-group__title">{{ group.label }} tools</span>
                <button type="button" class="btn btn--sm btn--secondary focusable" @click="setApiGroup(group.source, true)">All</button>
                <button type="button" class="btn btn--sm btn--secondary focusable" @click="setApiGroup(group.source, false)">None</button>
              </div>
              <label v-for="tool in group.tools" :key="tool.name" class="te-api-tool">
                <input
                  type="checkbox"
                  class="focusable"
                  :checked="apiAllowed.has(tool.name)"
                  @change="toggleApiTool(tool.name, ($event.target as HTMLInputElement).checked)"
                />
                <span class="te-api-tool__name">{{ tool.name }}</span>
                <span class="te-api-tool__desc">{{ tool.description }}</span>
              </label>
              <p v-if="group.tools.length === 0" class="te-section__hint">No tools available.</p>
            </div>
          </fieldset>

          <fieldset class="te-section">
            <legend class="te-section__legend">Environment Variables</legend>
            <p class="te-section__hint">
              Set a literal value or reference an existing host environment variable.
              Examples: <code>COPILOT_MODEL = gpt-5.1-chat</code>,
              <code>COPILOT_PROVIDER_API_KEY = %AZURE_API_KEY%</code>,
              <code>COPILOT_PROVIDER_BASE_URL = ${AZURE_API_BASE}</code>.
            </p>
            <div class="te-env-list te-env-list--managed">
              <div v-for="item in HELM_AUTOFILLED_ENV_ITEMS" :key="item.name" class="te-env-item te-grid-2col te-env-item--readonly">
                <input :value="item.name" type="text" class="te-input te-input--mono" readonly disabled />
                <input :value="item.value" type="text" class="te-input te-input--mono" readonly disabled />
              </div>
            </div>
            <p class="te-section__hint">Helm injects these values at runtime for every spawned CLI session. They are read-only here.</p>
            <div class="te-env-list">
              <div v-for="(item, idx) in envItems" :key="item.id" class="te-env-item te-grid-3col">
                <input :id="`te-env-name-${idx}`" type="text" class="te-input te-input--mono" placeholder="Variable name, e.g. PATH" :value="item.name" @input="item.name = ($event.target as HTMLInputElement).value" />
                <div class="te-env-value-row">
                  <input :id="`te-env-value-${idx}`" type="text" class="te-input te-input--mono" placeholder="Value or env ref like %AZURE_API_KEY% or ${AZURE_API_KEY}" :value="item.value" @input="item.value = ($event.target as HTMLInputElement).value" />
                  <button type="button" class="btn btn--sm btn--danger" title="Remove" @click="removeEnvItem(idx)">✕</button>
                </div>
                <select :id="`te-env-mode-${idx}`" class="te-input te-input--mode" :value="item.mode" @change="item.mode = ($event.target as HTMLSelectElement).value as 'replace' | 'append' | 'prepend'">
                  <option value="replace">Replace</option>
                  <option value="prepend">Prepend</option>
                  <option value="append">Append</option>
                </select>
              </div>
            </div>
            <button type="button" class="btn btn--secondary" @click="addEnvItem">+ Add Variable</button>
          </fieldset>

          <fieldset v-if="toolKind === 'cli'" class="te-section">
            <legend class="te-section__legend">Launch</legend>
            <div class="te-field"><label for="te-spawn">Spawn Command</label><input id="te-spawn" v-model="spawnCommand" type="text" placeholder="e.g. codex --dangerously-bypass-approvals-and-sandbox" class="te-input te-input--mono" /></div>
            <div class="te-field"><label for="te-resume">Resume Command</label><input id="te-resume" v-model="resumeCommand" type="text" placeholder="Template for resuming sessions" class="te-input te-input--mono" /></div>
            <div class="te-field"><label for="te-continue">Continue Command</label><input id="te-continue" v-model="continueCommand" type="text" placeholder="Template for continuing sessions" class="te-input te-input--mono" /></div>
            <div class="te-field"><label for="te-rename">Rename Command</label><input id="te-rename" v-model="renameCommand" type="text" placeholder="Template for renaming sessions" class="te-input te-input--mono" /></div>
          </fieldset>

          <fieldset class="te-section">
            <legend class="te-section__legend">Behavior</legend>
            <div class="te-grid-2col">
              <div class="te-field">
                <label for="te-delay">Initial Prompt Delay (ms)</label>
                <input id="te-delay" v-model.number="initialPromptDelay" type="number" min="0" step="100" class="te-input" />
              </div>
            </div>
            <div class="te-field">
              <label for="te-binding-profile">Binding Profile</label>
              <select id="te-binding-profile" v-model="bindingProfileId" class="te-select">
                <option value="">None</option>
                <option v-for="profile in bindingProfiles ?? []" :key="profile.id" :value="profile.id">{{ profile.name }}</option>
              </select>
              <p class="te-section__hint">Gamepad button map this CLI type uses. Profiles are edited in Settings → Bindings.</p>
            </div>
            <div class="te-field">
              <label for="te-submit-suffix">Submit Suffix</label>
              <select id="te-submit-suffix" v-model="submitSuffix" class="te-select">
                <option v-for="option in SUBMIT_SUFFIX_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
              <p class="te-section__hint">Character sequence sent when submitting text for this CLI type.</p>
            </div>
            <label class="te-checkbox-row"><input v-model="helmPreambleForInterSession" type="checkbox" /><span>Use Helm preamble for inter-session messages</span></label>
            <p class="te-section__hint">When enabled (default), inter-session messages are wrapped in a [HELM_MSG] envelope. When disabled, plain text only.</p>
            <label class="te-checkbox-row"><input v-model="largeTextAsTempFile" type="checkbox" /><span>Send large Helm MCP messages as temp file paths</span></label>
            <p class="te-section__hint">When enabled, large session_send_text payloads are written to a temp file and the recipient gets the file path plus reading instructions.</p>
            <label class="te-checkbox-row"><input v-model="messReminders" type="checkbox" /><span>Allow Mess reminders</span></label>
            <p class="te-section__hint">When enabled (default), a session of this type is nudged about unread Mess posts once it falls quiet. Turn off for CLIs that are not an LLM — the nudge is prose typed into stdin.</p>
            <label class="te-checkbox-row"><input v-model="mouseTracking" type="checkbox" /><span>Mouse tracking (app captures mouse; Shift+drag to select)</span></label>
            <label class="te-checkbox-row"><input v-model="noPromptCache" type="checkbox" /><span>No prompt cache (local model)</span></label>
            <div class="te-field"><label for="te-cache-warn">Short cache (minutes)</label><input id="te-cache-warn" v-model.number="cacheWarnMinutes" :disabled="noPromptCache" type="number" min="1" step="1" class="te-input focusable" /></div>
            <div class="te-field"><label for="te-cache-expire">Long cache (minutes)</label><input id="te-cache-expire" v-model.number="cacheExpireMinutes" :disabled="noPromptCache" type="number" min="1" step="1" class="te-input focusable" /></div>
            <p class="te-section__hint">Minutes since the last prompt. Past the short cache the row has faded, Mess reminders stop and an orange warning shows above the terminal; past the long cache it turns red. With no prompt cache, none of this applies: no fade, no warning, no auto-freeze.</p>
            <div class="te-field">
              <label for="te-keep-warm">Heartbeat text</label>
              <input id="te-keep-warm" v-model="keepWarmPrompt" :disabled="noPromptCache" type="text" :placeholder="KEEP_WARM_DEFAULT_TEXT" class="te-input focusable" />
              <p class="te-section__hint">What a Keep cache warm ping says, in sequence syntax. Blank uses the default shown. Helm sends it as <code>{{ HEARTBEAT_OPEN }} your text{{ HEARTBEAT_CLOSE }}</code>, so Quick Compact always strips it.</p>
            </div>
          </fieldset>

          <fieldset class="te-section">
            <legend class="te-section__legend">Helm Actions</legend>
            <p class="te-section__hint">
              Map Helm's worker-control MCP tools to this CLI's built-in commands, in sequence syntax
              (<code>{Enter}</code>, <code>{Wait 500}</code>, <code>{Ctrl+C}</code>). Leave a field blank to mark the
              action unsupported — its MCP tool then returns an error. Default is an implied Enter; add
              <code>{NoSend}</code> to suppress it, and <code>{Wait N}</code> to hold the MCP call's return by N ms.
            </p>
            <div class="te-field">
              <label for="te-action-clear">Clear <span class="te-params">no params</span></label>
              <input id="te-action-clear" v-model="helmActionClear" type="text" placeholder="e.g. /clear{Enter}" class="te-input te-input--mono" />
            </div>
            <div class="te-field">
              <label for="te-action-compact">Compact <span class="te-params">params: <code>$instruction</code></span></label>
              <input id="te-action-compact" v-model="helmActionCompact" type="text" placeholder="e.g. /compact $instruction{Enter}" class="te-input te-input--mono" />
            </div>
            <div class="te-field">
              <label for="te-action-export">Export <span class="te-params">params: <code>$path</code></span></label>
              <input id="te-action-export" v-model="helmActionExport" type="text" placeholder="e.g. /export $path{Enter}" class="te-input te-input--mono" />
            </div>
          </fieldset>

          <fieldset class="te-section te-section--prompts">
            <legend class="te-section__legend">Initial Prompts</legend>
            <div class="te-prompts-list">
              <div v-for="(item, idx) in promptItems" :key="idx" class="te-prompt-item">
                <div class="te-prompt-item__header">
                  <input type="text" class="te-input te-input--sm" placeholder="Label, e.g. commit" :value="item.label" @input="item.label = ($event.target as HTMLInputElement).value" />
                  <button type="button" class="btn btn--sm btn--danger" title="Remove" @click="removePromptItem(idx)">✕</button>
                </div>
                <PromptTextarea
                  v-model="item.sequence"
                  placeholder="Sequence, e.g. use skill(commit){Send}"
                  :rows="2"
                  :min-rows="2"
                  :max-rows="10"
                />
              </div>
            </div>
            <div class="te-prompts-actions">
              <button type="button" class="btn btn--secondary sequence-list-add" @click="addPromptItem">+ Add Item</button>
              <button type="button" class="btn btn--secondary" @click="addHelmInitPromptItem">+ Helm session init</button>
            </div>
          </fieldset>
        </div>

        <div class="modal-footer">
          <button class="btn btn--secondary" @click="onCancel">Cancel</button>
          <button class="btn btn--primary" @click="onSave">Save</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.tool-editor-modal { max-width: 720px; max-height: 90vh; }
.tool-editor-modal .modal-body { display: flex; flex-direction: column; gap: var(--spacing-md); }
.te-error { margin: 0; padding: 6px 10px; border: 1px solid rgba(255, 82, 82, 0.5); border-radius: var(--radius-sm); color: #ff8a8a; background: rgba(255, 82, 82, 0.08); font-size: var(--font-size-sm); }
.te-identity { margin: 0; color: var(--text-dim); font-size: 11px; font-family: 'Consolas', 'Courier New', monospace; user-select: text; }
.te-params { color: var(--text-dim); font-weight: 400; font-size: 0.85em; margin-left: var(--spacing-xs); }
.te-params code { color: #ffd479; }
.te-env-list { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.te-env-item { align-items: center; }
.te-env-item--readonly { opacity: 0.85; }
.te-env-list--managed { margin-bottom: var(--spacing-xs); }
.te-env-value-row { display: flex; align-items: center; gap: var(--spacing-sm); }
.te-env-value-row .te-input { flex: 1; }
.te-checkbox-row { display: flex; align-items: center; gap: var(--spacing-sm); margin-bottom: var(--spacing-sm); color: var(--text-primary); font-size: 13px; }
.te-checkbox-row input { width: 16px; height: 16px; }
.te-close-btn { background: none; border: none; color: var(--text-dim); font-size: var(--font-size-lg); cursor: pointer; padding: var(--spacing-xs); line-height: 1; transition: color 0.15s; }
.te-close-btn:hover { color: var(--text-primary); }
.te-section { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: var(--spacing-md); margin: 0; display: flex; flex-direction: column; gap: var(--spacing-sm); }
.te-section__hint { margin: 0; font-size: var(--font-size-sm); color: var(--text-dim); line-height: 1.4; }
.te-section__legend { font-size: var(--font-size-sm); font-weight: 600; color: var(--accent); padding: 0 var(--spacing-xs); user-select: none; }
.te-grid-2col { display: grid; grid-template-columns: 1fr 1fr; gap: var(--spacing-sm); }
.te-grid-3col { display: grid; grid-template-columns: 1fr 1fr auto; gap: var(--spacing-sm); align-items: center; }
.te-input--mode { width: 90px; padding: 4px 6px; font-size: 11px; background: var(--bg-primary); color: var(--text-secondary, #aaa); border: 1px solid var(--border, #444); border-radius: 4px; }
.te-field { display: flex; flex-direction: column; gap: var(--spacing-xs); }
.te-field label { font-size: var(--font-size-sm); color: var(--text-secondary); font-weight: 500; }
.te-input, .te-select { background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: var(--spacing-sm) var(--spacing-md); color: var(--text-primary); font-size: var(--font-size-md); font-family: inherit; width: 100%; }
.te-input:focus, .te-select:focus { border-color: var(--accent); outline: none; }
.te-input--mono { font-family: 'Consolas', 'Courier New', monospace; font-size: var(--font-size-sm); }
.te-input--sm { font-size: 11px; padding: var(--spacing-xs) var(--spacing-sm); }
.te-section--prompts .te-prompts-list { display: flex; flex-direction: column; gap: var(--spacing-xs); min-height: 60px; padding-right: var(--spacing-xs); }
.te-prompts-actions { display: flex; gap: var(--spacing-xs); flex-wrap: wrap; }
.te-prompt-item { display: flex; flex-direction: column; gap: var(--spacing-xs); padding: var(--spacing-sm); background: var(--bg-secondary); border-radius: var(--radius-sm); }
.te-prompt-item__header { display: flex; align-items: center; gap: 6px; }
.te-prompt-item__header .te-input--sm { flex: 1; }
.sequence-list-add { width: 100%; margin-top: 4px; }
.te-api-group { display: flex; flex-direction: column; gap: 2px; }
.te-api-group__header { display: flex; align-items: center; gap: var(--spacing-xs); margin: var(--spacing-xs) 0; }
.te-api-group__title { flex: 1; font-size: var(--font-size-sm); font-weight: 600; color: var(--text-secondary); }
.te-api-tool { display: grid; grid-template-columns: 16px 160px 1fr; align-items: baseline; gap: var(--spacing-sm); padding: 2px 0; font-size: var(--font-size-sm); color: var(--text-primary); cursor: pointer; }
.te-api-tool input { width: 16px; height: 16px; align-self: center; }
.te-api-tool__name { font-family: 'Consolas', 'Courier New', monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.te-api-tool__desc { color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
