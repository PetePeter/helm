import { OPERATOR_MANTRA } from '../../mcp/guides/operator-guide.js';
import {
  HELM_MSG_HOOK_RULES,
  HELM_TELEGRAM_HOOK_RULES,
  HELM_TELEGRAM_MODE_INSTRUCTIONS,
} from '../intersession-directive.js';

export const HOOK_INJECTION_DEFINITIONS = [
  {
    id: 'operatorMantra',
    label: 'Operator mantra',
    group: 'Session start',
    description:
      'Repeated for the Helm operator after session start and compaction.',
    defaultTemplate: OPERATOR_MANTRA,
  },
  {
    id: 'workingPlan',
    label: 'Working plan',
    group: 'Session start',
    description:
      'The claimed plan and completion guidance. Values: {{humanId}}, {{title}}, {{status}}.',
    defaultTemplate:
      'Working plan: {{humanId}} "{{title}}" ({{status}}). Complete it with plan_complete when done; session_plan_claim to put it down or take another.',
  },
  {
    id: 'openTasks',
    label: 'Open tasks',
    group: 'Session start',
    description: 'The operator’s in-flight tasks. Value: {{tasks}}.',
    defaultTemplate:
      'Your open tasks: {{tasks}}. Keep following each until done; when one is, plan_complete it (Helm cancels its timer).',
  },
  {
    id: 'reportsTo',
    label: 'Reports to',
    group: 'Session start',
    description:
      'Routing instructions for a session started by another Helm session. Value: {{sessionId}}.',
    defaultTemplate:
      'You were started by the Helm operator (session "{{sessionId}}") and work for it. Report progress, results and ANY questions to it with session_send_text (sessionId "{{sessionId}}"; expectsResponse=true for questions) — not to the user — until the user messages you directly.',
  },
  {
    id: 'missionStart',
    label: 'Mission at session start',
    group: 'Session start',
    description:
      'The session mission shown after start and compaction. Value: {{text}}.',
    defaultTemplate: '[HELM_MISSION] Current mission: "{{text}}".',
  },
  {
    id: 'ringRequests',
    label: 'Ring-me requests',
    group: 'Session start',
    description: 'Pending operator call-me reminders. Value: {{requests}}.',
    defaultTemplate:
      'Pending ring-me requests (your [RING-ME] memories): {{requests}}. Check each; when one is met, ring_user with a short reason, then memory_delete it.',
  },
  {
    id: 'handover',
    label: 'Handover note',
    group: 'Session start',
    description: 'The one-shot note carried across compaction.',
    defaultTemplate:
      'One-shot Handover note carried across your last compaction:\n{{content}}',
  },
  {
    id: 'manifestoContext',
    label: 'Manifesto context',
    group: 'Session start',
    description:
      'Persistent manifesto text. Use {{content}} to include the selected artifacts.',
    defaultTemplate: '{{content}}',
  },
  {
    id: 'helmMsgRules',
    label: 'Helm message rules',
    group: 'Prompt',
    description:
      'Instructions for messages from other Helm sessions or the paired phone.',
    defaultTemplate: HELM_MSG_HOOK_RULES,
  },
  {
    id: 'telegramRules',
    label: 'Telegram reply rules',
    group: 'Prompt',
    description: 'Reply instructions for Telegram messages.',
    defaultTemplate: HELM_TELEGRAM_HOOK_RULES,
  },
  {
    id: 'telegramMode',
    label: 'Telegram mode',
    group: 'Prompt',
    description: 'One-time instructions when a session enters Telegram mode.',
    defaultTemplate: HELM_TELEGRAM_MODE_INSTRUCTIONS,
  },
  {
    id: 'missionPromptUnset',
    label: 'Unset mission reminder',
    group: 'Prompt',
    description: 'Shown when a prompt arrives and no mission is set.',
    defaultTemplate:
      '[HELM_MISSION] No mission set. Call session_mission_set with a one-line TL;DR of what this session is doing.',
  },
  {
    id: 'missionPromptCurrent',
    label: 'Current mission reminder',
    group: 'Prompt',
    description:
      'Shown on every prompt while a mission is set. Value: {{text}}.',
    defaultTemplate:
      '[HELM_MISSION] Current mission: "{{text}}". If this prompt changes the direction of work, call session_mission_set with a new TL;DR (max 500 chars). Otherwise ignore.',
  },
  {
    id: 'suggestionPointer',
    label: 'Suggested context',
    group: 'Prompt',
    description:
      'The hint-only skill or memory suggestions. Use {{content}} to include the generated suggestions.',
    defaultTemplate: '{{content}}',
  },
  {
    id: 'aiagentNudge',
    label: 'AIAGENT state nudge',
    group: 'Prompt',
    description: 'One-time reminder to set the visible session state.',
    defaultTemplate:
      'Your AIAGENT state is unset — call session_set_aiagent_state so your row shows what you are doing.',
  },
  {
    id: 'startablePlanNudge',
    label: 'Startable plan nudge',
    group: 'Prompt',
    description:
      'One-time pointer to an available plan. Values: {{humanId}}, {{title}}.',
    defaultTemplate:
      'Startable plan here: {{humanId}} "{{title}}" — claim it with session_plan_claim if you want the work.',
  },
  {
    id: 'loopStopBlock',
    label: 'Loop stop prompt',
    group: 'Stop',
    description:
      'The continuation or verification prompt produced by plan loop driving. Use {{content}} to include it.',
    defaultTemplate: '{{content}}',
  },
  {
    id: 'stopPlanNudge',
    label: 'Open plan stop nudge',
    group: 'Stop',
    description:
      'One-time reminder not to stop with a claimed plan open. Values: {{humanId}}, {{title}}.',
    defaultTemplate:
      'You are stopping with plan item {{humanId}} "{{title}}" still claimed and open. Finish it, or complete/set it down with plan_complete or session_plan_claim, then stop again.',
  },
  {
    id: 'stopAiagentNudge',
    label: 'AIAGENT stop nudge',
    group: 'Stop',
    description: 'One-time reminder to set AIAGENT state before stopping.',
    defaultTemplate:
      'Your AIAGENT state is unset — call session_set_aiagent_state (e.g. "completed") before stopping.',
  },
  {
    id: 'amberContextAlert',
    label: 'Amber context alert',
    group: 'Context alerts',
    description:
      'Shown once on each user or Helm prompt above the amber limit. Available values: {{level}}, {{tokens}}, {{amber}}, {{red}}.',
    defaultTemplate:
      'AMBER: context usage is {{tokens}} tokens (amber {{amber}}, red {{red}}). If idle or finishing this step, consider compacting. Options: session_compact for normal compact; session_compact with handover to carry a note across; session_quick_compact to preserve a transcript and reload with a pointer. Native CLI compaction remains available.',
  },
  {
    id: 'redContextAlert',
    label: 'Red context alert',
    group: 'Context alerts',
    description:
      'Shown on every hook above the red limit. Available values: {{level}}, {{tokens}}, {{amber}}, {{red}}.',
    defaultTemplate:
      'RED: context usage is {{tokens}} tokens (red limit {{red}}). Request a Helm quick compact ASAP with session_quick_compact. Options: session_compact for normal compact; session_compact with handover to carry a note across; session_quick_compact to preserve a transcript and reload with a pointer. Native CLI compaction remains available.',
  },
] as const;

export type HookInjectionId = (typeof HOOK_INJECTION_DEFINITIONS)[number]['id'];
export type HookInjectionOverrides = Partial<Record<HookInjectionId, string>>;
export type HookInjectionValues = Record<string, string | number | undefined>;

const DEFINITIONS_BY_ID = new Map(
  HOOK_INJECTION_DEFINITIONS.map((item) => [item.id, item]),
);

export function isHookInjectionId(value: string): value is HookInjectionId {
  return DEFINITIONS_BY_ID.has(value as HookInjectionId);
}

export function getDefaultHookInjectionTemplates(): Record<
  HookInjectionId,
  string
> {
  return Object.fromEntries(
    HOOK_INJECTION_DEFINITIONS.map(({ id, defaultTemplate }) => [
      id,
      defaultTemplate,
    ]),
  ) as Record<HookInjectionId, string>;
}

export function renderHookInjection(
  id: HookInjectionId,
  values: HookInjectionValues = {},
  overrides: HookInjectionOverrides = {},
): string {
  const template = overrides[id] ?? DEFINITIONS_BY_ID.get(id)!.defaultTemplate;
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key: string) =>
    String(values[key] ?? ''),
  );
}
