/**
 * The one list of settings pages. Nav grouping, nav order and the
 * persisted-tab migration all read from here, so adding a page is one entry
 * rather than edits in the panel, the input router and the tab cycler.
 */

export type SettingsGroup = 'Sessions' | 'Knowledge' | 'Connections' | 'System';

export interface SettingsPageDef {
  id: string;
  label: string;
  group: SettingsGroup;
  /** Key into SETTINGS_ICONS. */
  icon: string;
  /** Optional keyboard shortcut displayed beside this nav entry. */
  shortcut?: string;
}

export const SETTINGS_GROUPS: readonly SettingsGroup[] = ['Sessions', 'Knowledge', 'Connections', 'System'];

export const SETTINGS_PAGES: readonly SettingsPageDef[] = [
  { id: 'tools', label: 'Tools', group: 'Sessions', icon: 'terminal' },
  { id: 'session-list', label: 'Session list', group: 'Sessions', icon: 'list' },
  { id: 'bindings', label: 'Bindings', group: 'Sessions', icon: 'gamepad' },
  { id: 'chipbar-actions', label: 'Chip actions', group: 'Sessions', icon: 'bolt' },
  { id: 'projects', label: 'Projects', group: 'Knowledge', icon: 'folder' },
  { id: 'skills', label: 'Skills', group: 'Knowledge', icon: 'book' },
  { id: 'auto-memory', label: 'Auto memory', group: 'Knowledge', icon: 'database' },
  { id: 'dreaming', label: 'Dreaming', group: 'Knowledge', icon: 'moon', shortcut: 'Ctrl+Shift+G' },
  { id: 'telegram', label: 'Telegram', group: 'Connections', icon: 'send' },
  { id: 'mobile', label: 'Mobile', group: 'Connections', icon: 'phone' },
  { id: 'peers', label: 'Fleet', group: 'Connections', icon: 'link' },
  { id: 'mcp', label: 'MCP server', group: 'Connections', icon: 'plug' },
  { id: 'cli-integrations', label: 'CLI integrations', group: 'Connections', icon: 'hook' },
  { id: 'operator', label: 'Operator', group: 'System', icon: 'mic' },
  { id: 'voice', label: 'Voice', group: 'System', icon: 'speaker' },
  { id: 'updates', label: 'Updates', group: 'System', icon: 'download' },
  { id: 'scheduled-tasks', label: 'Scheduled tasks', group: 'System', icon: 'clock' },
];

/** Persisted ids from before the redesign that no longer exist. */
const LEGACY_IDS: Record<string, string> = { profiles: 'tools' };

/** Resolve a persisted or requested tab id to a page that exists. */
export function resolveSettingsPage(id: string | null | undefined): SettingsPageDef {
  const wanted = LEGACY_IDS[id ?? ''] ?? id;
  return SETTINGS_PAGES.find((page) => page.id === wanted) ?? SETTINGS_PAGES[0];
}

export function pagesInGroup(group: SettingsGroup): SettingsPageDef[] {
  return SETTINGS_PAGES.filter((page) => page.group === group);
}

/** Wrap-around step through the nav order. */
export function stepSettingsPage(id: string, delta: number): string {
  const count = SETTINGS_PAGES.length;
  const index = SETTINGS_PAGES.findIndex((page) => page.id === id);
  const from = index < 0 ? 0 : index;
  return SETTINGS_PAGES[(((from + delta) % count) + count) % count].id;
}

/**
 * Lucide-style 24×24 line icons, as path data only. Stroke colour comes from
 * currentColor, so the tinted-fill selection recolours them for free.
 */
export const SETTINGS_ICONS: Record<string, string> = {
  terminal: 'M4 17l6-6-6-6M12 19h8',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  gamepad: 'M6 12h4M8 10v4M15 13h.01M18 11h.01M17.32 5H6.68a4 4 0 0 0-3.98 3.59L2 15a3 3 0 0 0 5.2 2.1L9 15h6l1.8 2.1A3 3 0 0 0 22 15l-.7-6.41A4 4 0 0 0 17.32 5z',
  bolt: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
  folder: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5',
  database: 'M12 2c4.97 0 9 1.34 9 3s-4.03 3-9 3-9-1.34-9-3 4.03-3 9-3zM21 12c0 1.66-4 3-9 3s-9-1.34-9-3M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z',
  phone: 'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM12 18h.01',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  plug: 'M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4',
  hook: 'M18 6a3 3 0 1 0-4 2.83V15a4 4 0 0 1-8 0v-3M6 12l-3 3M6 12l3 3',
  mic: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3',
  speaker: 'M11 5L6 9H2v6h4l5 4zM15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  moon: 'M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13z',
};
