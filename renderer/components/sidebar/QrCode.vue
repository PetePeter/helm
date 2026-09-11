<script setup lang="ts">
/**
 * QrCode.vue — a scannable QR for a short payload, drawn as one SVG path.
 *
 * The modules are emitted as a single `<path>` rather than a few hundred
 * `<rect>`s, and the geometry is bound rather than injected as markup, so
 * nothing here goes near `v-html`.
 *
 * DELIBERATE TOKEN EXCEPTION: the code is drawn black-on-white in both themes.
 * A QR is read by a camera, not by a person, and scanners lose inverted or
 * low-contrast codes. Theming it would make it prettier and sometimes
 * unreadable — and an unreadable code fails looking like a code.
 */
import { computed } from 'vue';
import qrcode from 'qrcode-generator';

const props = withDefaults(defineProps<{
  /** Encoded exactly as given — no trimming, no padding, no trailing newline. */
  payload: string;
  /** Rendered edge length in CSS pixels. */
  size?: number;
}>(), { size: 148 });

/** Four modules is the quiet zone the spec requires for a reliable read. */
const MARGIN = 4;

const code = computed(() => {
  // Type 0 = pick the smallest version that fits. 'M' tolerates a smudged or
  // off-angle phone camera without inflating the module count.
  const qr = qrcode(0, 'M');
  qr.addData(props.payload);
  qr.make();
  return qr;
});

const moduleCount = computed(() => code.value.getModuleCount());
const viewBoxSize = computed(() => moduleCount.value + MARGIN * 2);

/** One path covering every dark module, as a run of 1x1 squares. */
const path = computed(() => {
  const qr = code.value;
  const count = moduleCount.value;
  const parts: string[] = [];
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) parts.push(`M${col + MARGIN} ${row + MARGIN}h1v1h-1z`);
    }
  }
  return parts.join('');
});
</script>

<template>
  <svg
    class="qr"
    :width="props.size"
    :height="props.size"
    :viewBox="`0 0 ${viewBoxSize} ${viewBoxSize}`"
    shape-rendering="crispEdges"
    role="img"
    aria-label="QR code for the Helm app download link"
  >
    <rect :width="viewBoxSize" :height="viewBoxSize" fill="#ffffff" />
    <path :d="path" fill="#000000" />
  </svg>
</template>

<style scoped>
.qr {
  border-radius: 4px;
  flex-shrink: 0;
}
</style>
