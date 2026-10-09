import { ref } from 'vue';
import { dockPaneRegistry } from './dock-types.js';

/** Reactive revision for consumers that derive UI from the data-only registry. */
export const paneRegistryRevision = ref(0);
dockPaneRegistry.subscribe(() => { paneRegistryRevision.value++; });
