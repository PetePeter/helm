/** Permission presets shown in Settings → Mobile. */
export const ALLOW_PRESETS: Array<{ label: string; globs: string[] }> = [
  {
    label: 'Read-only',
    globs: [
      'session_list', 'directory_list', 'project_list',
      'plan_list', 'plan_summary', 'plan_get', 'plan_get_id',
      'plan_context_list', 'sequence_list', 'sequence_get',
      'context_list', 'context_get',
    ],
  },
  { label: 'Artifacts', globs: ['session_artifact_*'] },
  { label: 'Sessions', globs: ['session_*'] },
  { label: 'All', globs: ['*'] },
];
