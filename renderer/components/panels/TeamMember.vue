<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  state: 'implementing' | 'waiting' | 'planning' | 'completed' | 'idle';
  /** Unread notifications force the waving pose — the figure flags for attention. */
  alert?: boolean;
}>();

const pose = computed(() => {
  if (props.alert) return 'input';
  return {
    implementing: 'busy', planning: 'busy', waiting: 'input', completed: 'done', idle: 'idle',
  }[props.state];
});
</script>

<template>
  <div class="team-member" :class="`team-member--${pose}`" aria-hidden="true">
    <svg viewBox="0 0 78 86">
      <path class="chairback" d="M58 84 V58 q0-6 6-6 h4" />
      <template v-if="pose === 'busy'">
        <g class="headg"><circle class="skin" cx="34" cy="26" r="9" /><path class="hair" d="M25 24a9 9 0 0 1 18 0c0-7-18-8-18 0z" /></g>
        <path class="torso" d="M22 40 q12-8 24 0 l3 26 h-30z" /><rect class="skin armL" x="10" y="45" width="16" height="5.5" rx="2.7" /><rect class="skin armR" x="12" y="53" width="16" height="5.5" rx="2.7" /><rect x="46" y="66" width="18" height="6" rx="3" fill="#36485a" />
      </template>
      <template v-else-if="pose === 'input'">
        <circle cx="15" cy="10" r="9" fill="#ffc65c" /><circle cx="15" cy="14.5" r="1.6" fill="#22160a" /><circle class="skin" cx="34" cy="26" r="9" /><path class="hair" d="M25 24a9 9 0 0 1 18 0c0-7-18-8-18 0z" /><path class="torso" d="M22 40 q12-8 24 0 l3 26 h-30z" /><g class="armUp"><rect class="skin" x="19" y="18" width="5.5" height="24" rx="2.7" /><circle class="skin" cx="21.7" cy="17" r="4" /></g>
      </template>
      <template v-else-if="pose === 'done'">
        <circle class="skin" cx="30" cy="22" r="9" /><path class="hair" d="M21 20a9 9 0 0 1 18 0c0-7-18-8-18 0z" /><path class="torso" d="M18 36 q12-8 24 0 l2 30 h-28z" /><path class="torso" d="M52 34h20v25H52z" /><rect x="55" y="39" width="14" height="2" rx="1" fill="#7cc0ff" />
      </template>
      <template v-else>
        <text class="zz" x="46" y="18">z</text><text class="zz" x="53" y="24">z</text><g class="lean"><circle class="skin" cx="34" cy="28" r="9" /><path class="hair" d="M25 26a9 9 0 0 1 18 0c0-7-18-8-18 0z" /><path class="torso" d="M22 42 q12-8 24 0 l3 24 h-30z" /><rect x="18" y="26" width="12" height="19" rx="2.6" fill="#0e1722" stroke="#5d7189" /></g>
      </template>
    </svg>
  </div>
</template>

<style scoped>
/* Static inside the desk's avatar rail: the figure is contained by its tile
   and can never overhang neighbouring desks. Width scales to the rail; the
   viewBox ratio keeps the figure proportional. */
.team-member{position:static;display:block;width:100%;max-height:100%;max-width:100%}.team-member svg{display:block;width:100%;height:auto;overflow:visible}.chairback{fill:none;stroke:#36485a;stroke-width:5;stroke-linecap:round}.skin{fill:#f0c39c}.hair{fill:#3d4f66}.torso{fill:#64748b}.team-member--busy .torso{fill:#438de8}.team-member--input .torso{fill:#e2a43c}.team-member--done .torso{fill:#56a87b}.team-member--idle .torso{fill:#718096}.team-member--busy .armL{animation:tap .38s ease-in-out infinite}.team-member--busy .armR{animation:tap .38s ease-in-out infinite .19s}.team-member--input .armUp{transform-origin:22px 40px;animation:wave .9s ease-in-out infinite}.zz{font:bold 9px sans-serif;fill:#7d8ea3;animation:fade 3.2s ease-out infinite}@keyframes tap{50%{transform:translateY(2px)}}@keyframes wave{50%{transform:rotate(10deg)}}@keyframes fade{to{opacity:0;transform:translate(4px,-8px)}}
</style>
