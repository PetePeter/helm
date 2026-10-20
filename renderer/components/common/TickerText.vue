<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

/**
 * One text line that scrolls like a news ticker when (and only when) the chip
 * width would clip it. Lines that fit stay static with the usual ellipsis;
 * clipped lines loop continuously — one run plus a fixed gap is a "unit", and
 * the animation translates exactly one unit so the two copies tile seamlessly.
 */

const props = defineProps<{
  text: string;
}>();

const GAP = 24; // px between the two copies
const PX_PER_SECOND = 30; // every clipped line scrolls at the same speed
const MIN_SECONDS = 3;

const host = ref<HTMLElement | null>(null);
const scrolling = ref(false);
const durationSec = ref(0);

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Static mode must be rendered before measuring: the single-copy layout is
// what tells us the text's natural width. A track with two copies would
// double every width it reports.
async function remeasure(): Promise<void> {
  scrolling.value = false;
  await nextTick();
  const el = host.value;
  if (!el) return;
  const clipped = el.scrollWidth > el.clientWidth + 1;
  scrolling.value = clipped && !prefersReducedMotion();
  if (scrolling.value) {
    await nextTick();
    // In scrolling layout the host's overflow IS the two-copy track, so one
    // loop unit (text + gap) is exactly half of it.
    const unit = el.scrollWidth / 2;
    durationSec.value = Math.round(Math.max(unit / PX_PER_SECOND, MIN_SECONDS) * 100) / 100;
  }
}

let observer: ResizeObserver | null = null;

onMounted(() => {
  void remeasure();
  // Chip width can change (pane resize, pop-out window) without the text
  // changing; watch the host box so the ticker keeps matching reality.
  if (typeof ResizeObserver !== 'undefined' && host.value) {
    observer = new ResizeObserver(() => void remeasure());
    observer.observe(host.value);
  }
});

onBeforeUnmount(() => observer?.disconnect());

watch(() => props.text, () => void remeasure());

defineExpose({ remeasure });
</script>

<template>
  <span
    ref="host"
    class="ticker-text"
    :class="{ 'ticker-text--scrolling': scrolling }"
  >
    <span
      v-if="scrolling"
      class="ticker-text__track"
      :style="{ animationDuration: `${durationSec}s` }"
    >
      <span class="ticker-text__run">{{ text }}</span>
      <span class="ticker-text__run" aria-hidden="true">{{ text }}</span>
    </span>
    <span v-else class="ticker-text__run">{{ text }}</span>
  </span>
</template>

<style scoped>
.ticker-text {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  min-width: 0;
}
/* Static run stays inline so the root's ellipsis still applies to it. */
.ticker-text__run { display: inline; }

.ticker-text--scrolling { text-overflow: clip; }
.ticker-text--scrolling .ticker-text__run {
  display: inline-block;
  padding-right: 24px; /* GAP — one run + one gap is one seamless loop unit */
}
.ticker-text__track {
  display: inline-block;
  white-space: nowrap;
  will-change: transform;
  animation: ticker-scroll linear infinite;
}
@keyframes ticker-scroll {
  from { transform: translateX(0); }
  to { transform: translateX(-50%); }
}

@media (prefers-reduced-motion: reduce) {
  .ticker-text__track { animation: none; }
}
</style>
