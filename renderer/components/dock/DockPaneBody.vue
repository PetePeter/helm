<template>
  <div class="dock-pane-body">
    <slot />
  </div>
</template>

<style scoped>
/* Pane content has no header or collapse control; the dock owns both. */
.dock-pane-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--spacing-sm);
}
</style>
