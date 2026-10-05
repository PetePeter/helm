<script setup lang="ts">
import { nextTick, onUnmounted, ref, watch } from 'vue';
import { FORM_KEYS, SELECTION_KEYS, useModalStack } from '../../composables/useModalStack.js';
import { useModalAutofocus } from '../../composables/useModalAutofocus.js';
import type { useFirstRunOnboarding } from '../../composables/useFirstRunOnboarding.js';
import { ONBOARDING_SETTING_GROUPS } from '../../onboarding-settings-topics.js';
import { toDirection } from '../../utils.js';

const props = defineProps<{ flow: ReturnType<typeof useFirstRunOnboarding> }>();
const flow = props.flow;
const { visible, stage, tools, directories, selectedCli, selectedDirectory, prompt, busy, error, hasTools } = flow;
const root = ref<HTMLElement | null>(null);
const modalStack = useModalStack();
const { focusIntoModal } = useModalAutofocus(root, '.onboarding-primary');
const topics = ONBOARDING_SETTING_GROUPS.flatMap(group => group.topics);
const topicIndex = ref(0);

function handleButton(button: string): boolean {
  const direction = toDirection(button);
  if (direction === 'up' || direction === 'down') {
    const step = direction === 'down' ? 1 : -1;
    if (stage.value === 'cli' && tools.value.length) {
      const index = tools.value.findIndex(tool => tool.id === selectedCli.value);
      flow.chooseCli(tools.value[Math.max(0, Math.min(tools.value.length - 1, index + step))].id);
    } else if (stage.value === 'directory' && directories.value.length) {
      const index = directories.value.findIndex(item => item.path === selectedDirectory.value);
      flow.chooseExistingDirectory(directories.value[Math.max(0, Math.min(directories.value.length - 1, index + step))].path);
    } else if (stage.value === 'configure') {
      topicIndex.value = Math.max(0, Math.min(topics.length - 1, topicIndex.value + step));
    }
    return true;
  }
  if (button === 'A') {
    if (stage.value === 'cli') flow.continueFromCli();
    else if (stage.value === 'directory') flow.continueFromDirectory();
    else if (stage.value === 'prompt') void flow.startSession();
    else if (stage.value === 'success') void flow.finish();
    else flow.openSettings(topics[topicIndex.value]?.tabId ?? 'tools');
    return true;
  }
  if (button === 'B') {
    if (stage.value === 'success') void flow.finish();
    else if (stage.value === 'cli') void flow.showConfiguration();
    else flow.back();
    return true;
  }
  return true;
}

watch([visible, stage], async ([isVisible, currentStage]) => {
  if (isVisible) {
    modalStack.push({ id: 'first-run-onboarding', handler: handleButton, interceptKeys: currentStage === 'prompt' ? FORM_KEYS : SELECTION_KEYS });
    await nextTick();
    await focusIntoModal();
  } else {
    modalStack.pop('first-run-onboarding');
  }
});

onUnmounted(() => modalStack.pop('first-run-onboarding'));
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" ref="root" class="modal-overlay modal--visible onboarding-overlay" role="dialog" aria-modal="true" aria-label="Helm getting started" tabindex="-1">
      <main class="onboarding-card">
        <header class="onboarding-header">
          <div class="onboarding-brand"><span>H</span><b>Helm</b><small>steer your fleet of agents</small></div>
          <button class="btn btn--secondary btn--sm focusable" @click="flow.showConfiguration">{{ stage === 'configure' || stage === 'success' ? 'Close' : 'Skip to optional setup' }}</button>
        </header>

        <div v-if="stage !== 'configure'" class="onboarding-layout">
          <aside class="onboarding-intro">
            <div class="onboarding-eyebrow">{{ stage === 'success' ? 'You’re underway' : 'Welcome aboard' }}</div>
            <h1>{{ stage === 'success' ? 'That’s Helm working.' : 'Let’s get your first session running.' }}</h1>
            <p>{{ stage === 'success' ? 'Your agent is ready. Configure the rest whenever you need it.' : 'Three quick steps. Configure the rest when you need it.' }}</p>
            <div v-if="stage !== 'success'" class="onboarding-steps">
              <span :class="{ active: stage === 'cli', done: stage !== 'cli' }">1　Choose a CLI</span>
              <span :class="{ active: stage === 'directory', done: stage === 'prompt' }">2　Choose a folder</span>
              <span :class="{ active: stage === 'prompt' }">3　Try a prompt</span>
            </div>
          </aside>

          <section class="onboarding-main" aria-live="polite">
            <template v-if="stage === 'cli'">
              <h2>Which CLI do you use?</h2><p class="onboarding-muted">Helm opens an agent configured in your Tools settings.</p>
              <div v-if="hasTools" class="onboarding-list">
                <button v-for="tool in tools" :key="tool.id" class="onboarding-choice focusable" :class="{ selected: selectedCli === tool.id }" @click="flow.chooseCli(tool.id)"><b>{{ tool.name }}</b><small>Configured in Helm</small></button>
              </div>
              <p v-else class="onboarding-empty">No CLI tools are configured yet. Add one in Settings, then return here.</p>
              <div class="onboarding-actions"><button v-if="!hasTools" class="btn btn--secondary focusable" @click="flow.openSettings('tools')">Open Tools settings</button><span v-else /><button class="btn btn--primary onboarding-primary focusable" :disabled="!hasTools" @click="flow.continueFromCli">Continue →</button></div>
            </template>

            <template v-else-if="stage === 'directory'">
              <h2>Where should your session work?</h2><p class="onboarding-muted">Choose a project folder. Your agent will start there.</p>
              <div v-if="directories.length" class="onboarding-list onboarding-folder-list">
                <button v-for="directory in directories" :key="directory.path" class="onboarding-choice focusable" :class="{ selected: selectedDirectory === directory.path }" @click="flow.chooseExistingDirectory(directory.path)"><b>{{ directory.name }}</b><small>{{ directory.path }}</small></button>
              </div>
              <p v-else class="onboarding-empty">Add a project folder to start your first session.</p>
              <div class="onboarding-actions"><button class="btn btn--secondary focusable" :disabled="busy" @click="flow.browseForDirectory">{{ busy ? 'Adding folder…' : 'Choose folder…' }}</button><span class="onboarding-action-right"><button class="btn btn--secondary focusable" @click="flow.back">← Back</button><button class="btn btn--primary onboarding-primary focusable" :disabled="!selectedDirectory || busy" @click="flow.continueFromDirectory">Continue →</button></span></div>
            </template>

            <template v-else-if="stage === 'prompt'">
              <h2>Your first prompt</h2><p class="onboarding-muted">A small task is a good way to see Helm in action.</p>
              <div class="onboarding-terminal"><b>● New {{ tools.find(tool => tool.id === selectedCli)?.name || 'CLI' }} session</b><small>{{ selectedDirectory }}</small><small>Ready for your instructions</small></div>
              <label for="first-prompt">Try asking</label><textarea id="first-prompt" v-model="prompt" class="onboarding-prompt" rows="3" :disabled="busy" />
              <div class="onboarding-presets"><button class="btn btn--secondary btn--sm focusable" @click="prompt = 'Find the main entry point and explain it.'">Explain this project</button><button class="btn btn--secondary btn--sm focusable" @click="prompt = 'Find one small improvement I could make.'">Suggest an improvement</button></div>
              <div class="onboarding-actions"><button class="btn btn--secondary focusable" :disabled="busy" @click="flow.back">← Back</button><button class="btn btn--primary onboarding-primary focusable" :disabled="busy || !prompt.trim()" @click="flow.startSession">{{ busy ? 'Starting session…' : 'Start session and send ↗' }}</button></div>
            </template>

            <template v-else>
              <div class="onboarding-success">✓</div><h2>Your first session is ready.</h2><p class="onboarding-muted">Keep working, or explore the rest of Helm below.</p>
              <div class="onboarding-actions"><button class="btn btn--secondary focusable" @click="flow.showConfiguration">Configure Helm</button><button class="btn btn--primary onboarding-primary focusable" @click="flow.finish">Go to my sessions →</button></div>
            </template>
            <p v-if="error" class="onboarding-error" role="alert">{{ error }}</p>
          </section>
        </div>

        <section v-else class="onboarding-settings">
          <header><div><div class="onboarding-eyebrow">Optional · do this anytime</div><h1>Make Helm yours.</h1><p class="onboarding-muted">Choose any topic. Each one opens the existing setting.</p></div><button class="btn btn--secondary focusable" @click="flow.finish">Go to sessions</button></header>
          <div v-for="group in ONBOARDING_SETTING_GROUPS" :key="group.label" class="onboarding-group"><h2>{{ group.label }}</h2><div class="onboarding-topics"><button v-for="topic in group.topics" :key="topic.title" class="onboarding-topic focusable" @click="flow.openSettings(topic.tabId)"><b>{{ topic.title }}</b><small>{{ topic.description }}</small><span>Open settings →</span></button></div></div>
          <p v-if="error" class="onboarding-error" role="alert">{{ error }}</p>
        </section>
      </main>
    </div>
  </Teleport>
</template>

<style scoped>
.onboarding-overlay{z-index:1500}.onboarding-card{width:min(1040px,calc(100% - 28px));max-height:calc(100vh - 36px);overflow:auto;background:var(--bg-primary);color:var(--text-primary);border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:0 24px 80px #0009}.onboarding-header{position:sticky;top:0;z-index:1;display:flex;justify-content:space-between;align-items:center;padding:14px 20px;background:var(--bg-secondary);border-bottom:1px solid var(--border)}.onboarding-brand{display:flex;align-items:center;gap:10px}.onboarding-brand>span{display:grid;place-items:center;width:32px;height:32px;border-radius:10px;background:#d4f27c;color:#172019;font-weight:900}.onboarding-brand small{color:var(--text-secondary);margin-left:4px}.onboarding-layout{display:grid;grid-template-columns:300px minmax(0,1fr);min-height:490px}.onboarding-intro{padding:38px 28px;background:linear-gradient(150deg,#192522,#151d1d)}.onboarding-eyebrow{font-size:11px;font-weight:750;letter-spacing:.12em;text-transform:uppercase;color:#d4f27c}.onboarding-intro h1,.onboarding-settings h1{font-size:31px;line-height:1.12;letter-spacing:-.035em;margin:12px 0}.onboarding-intro p,.onboarding-muted{color:var(--text-secondary)}.onboarding-steps{display:grid;gap:9px;margin-top:30px;color:var(--text-secondary);font-size:13px}.onboarding-steps span{padding:9px;border-radius:8px}.onboarding-steps .active{background:#26332e;color:var(--text-primary)}.onboarding-steps .done{color:#b2d8ba}.onboarding-main{align-self:center;padding:32px 40px}.onboarding-main h2{margin:0;font-size:23px}.onboarding-muted{margin:5px 0 20px}.onboarding-list{display:grid;gap:9px}.onboarding-folder-list{max-height:245px;overflow:auto}.onboarding-choice{display:grid;gap:3px;text-align:left;padding:12px 14px;border:1px solid var(--border);border-radius:11px;background:var(--bg-secondary);color:inherit}.onboarding-choice.selected,.onboarding-choice:hover{border-color:#a9e7bd;background:#21312b}.onboarding-choice small,.onboarding-topic small,.onboarding-terminal small{color:var(--text-secondary);overflow-wrap:anywhere}.onboarding-empty{padding:18px;border:1px dashed var(--border);border-radius:11px;color:var(--text-secondary)}.onboarding-actions,.onboarding-settings>header{display:flex;justify-content:space-between;align-items:center;gap:9px;margin-top:22px}.onboarding-settings>header{margin-top:0}.onboarding-action-right{display:flex;gap:8px}.onboarding-terminal{display:grid;gap:5px;padding:12px;margin:12px 0;border:1px solid var(--border);border-radius:10px;background:var(--bg-secondary);font:12px ui-monospace,monospace}.onboarding-main label{font-size:12px;color:var(--text-secondary)}.onboarding-prompt{display:block;width:100%;margin-top:6px;padding:12px;border:1px solid var(--border);border-radius:10px;background:var(--bg-secondary);color:inherit;font:inherit;resize:vertical}.onboarding-presets{display:flex;gap:8px;margin-top:8px}.onboarding-success{display:grid;place-items:center;width:52px;height:52px;margin-bottom:14px;border-radius:15px;background:#284b38;color:#d4f27c;font-size:26px}.onboarding-settings{padding:28px 34px}.onboarding-group{margin-top:21px}.onboarding-group h2{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#d4f27c}.onboarding-topics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin-top:8px}.onboarding-topic{display:grid;gap:5px;min-height:91px;padding:12px;text-align:left;border:1px solid var(--border);border-radius:10px;background:var(--bg-secondary);color:inherit}.onboarding-topic:hover{border-color:#a9e7bd}.onboarding-topic span{align-self:end;color:#d4f27c;font-size:11px}.onboarding-error{padding:10px 12px;margin-top:14px;background:#39241f;color:#ffd0c7;border:1px solid #824b43;border-radius:9px;font-size:13px}@media(max-width:720px){.onboarding-layout{grid-template-columns:1fr}.onboarding-intro{padding:20px}.onboarding-intro h1,.onboarding-settings h1{font-size:26px;margin:7px 0}.onboarding-steps{display:flex;margin-top:12px}.onboarding-steps span{font-size:0;padding:5px}.onboarding-steps span::first-letter{font-size:13px}.onboarding-main,.onboarding-settings{padding:21px}.onboarding-topics{grid-template-columns:1fr 1fr}.onboarding-brand small{display:none}}@media(max-width:480px){.onboarding-topics{grid-template-columns:1fr}.onboarding-settings>header{display:block}.onboarding-actions{align-items:stretch;flex-direction:column-reverse}.onboarding-action-right{justify-content:space-between}}
</style>
