<script setup lang="ts">
/**
 * SettingsPane.vue — one gamepad pane of a settings page (◀▶ moves between
 * panes). Registers itself with SettingsScreen; outside it, a plain div.
 */
import { ref } from 'vue';
import { useSettingsPane } from '../settings-panes.js';

const el = ref<HTMLElement | null>(null);
useSettingsPane(el);
</script>

<template>
  <div ref="el"><slot /></div>
</template>
