export interface OnboardingSettingTopic {
  title: string;
  description: string;
  tabId: string;
}

export interface OnboardingSettingGroup {
  label: string;
  topics: OnboardingSettingTopic[];
}

/** The setup hub is navigation only; each topic opens its existing Settings tab. */
export const ONBOARDING_SETTING_GROUPS: OnboardingSettingGroup[] = [
  {
    label: 'Agent setup',
    topics: [
      { title: 'CLI tools', description: 'Commands, launch prompts and environment', tabId: 'tools' },
      { title: 'MCP server', description: 'Connect agents to Helm tools', tabId: 'mcp' },
      { title: 'CLI hooks', description: 'Activity reporting, context alerts, and editable context injections', tabId: 'cli-integrations' },
      { title: 'Operator', description: 'Configure Helm’s voice operator', tabId: 'operator' },
    ],
  },
  {
    label: 'Workflows',
    topics: [
      { title: 'Session List', description: 'Choose how session output previews appear', tabId: 'session-list' },
      { title: 'Projects and folders', description: 'Organize repositories and working directories', tabId: 'projects' },
      { title: 'Profiles and controls', description: 'Choose reusable keyboard and gamepad bindings', tabId: 'bindings' },
      { title: 'Skills', description: 'Reusable agent instructions', tabId: 'skills' },
      { title: 'Auto memory', description: 'Pick the model that records memories for every session', tabId: 'auto-memory' },
      { title: 'Quick actions', description: 'Reusable prompts and workflow shortcuts', tabId: 'chipbar-actions' },
      { title: 'Scheduled tasks', description: 'Create a recurring or one-time prompt', tabId: 'scheduled-tasks' },
    ],
  },
  {
    label: 'Connect',
    topics: [
      { title: 'Phone app', description: 'Pair a phone over Bluetooth or local network', tabId: 'mobile' },
      { title: 'Fleet', description: 'Pair another Helm desktop', tabId: 'peers' },
      { title: 'Telegram and notifications', description: 'Control sessions and choose which updates to receive', tabId: 'telegram' },
      { title: 'Voice', description: 'Configure speech and audio tools', tabId: 'voice' },
    ],
  },
  {
    label: 'Helm',
    topics: [
      { title: 'Updates', description: 'Choose how Helm checks for new versions', tabId: 'updates' },
    ],
  },
];
