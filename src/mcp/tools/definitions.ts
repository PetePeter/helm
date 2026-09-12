import type { McpTool } from './types.js';
import { MEMORY_DREAM_MAX_CANDIDATES, MEMORY_DREAM_MIN_CANDIDATES } from '../../types/memory.js';

export const REQUIRED_PLAN_DESCRIPTION_SECTIONS = [
  'Problem Statement',
  'User POV',
  'Done Statement',
  'Files / Classes Affected',
  'TDD Suggestions',
  'Acceptance Criteria',
];

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'tool_list',
    title: 'List CLI Types',
    description: 'List CLI types configured in Helm and the configured working directories they can be spawned into. Call this near the start of a Helm workflow when you need to know what CLIs and spawn targets are actually available before creating a session.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'skill_list',
    title: 'List Skills',
    description: 'List Helm skills applicable to the caller\'s project as minimal summaries (id, name, triggerCondition — when to apply each). This is only a directory; call skill_get(id) to retrieve a skill\'s full detail (body, type, scope) before applying or editing it. Pass projectId or dirPath to filter to a specific project.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        dirPath: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'skill_get',
    title: 'Get Skill',
    description: 'Fetch one Helm skill by id or resolve the effective skill by type. Pass id for exact lookup, or pass type with optional projectId/dirPath for type-based resolution (respects project scope precedence).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Exact skill UUID for direct lookup.' },
        type: { type: 'string', description: 'Stable skill type for effective resolution.' },
        projectId: { type: 'string', description: 'Project ID for type-based scope resolution.' },
        dirPath: { type: 'string', description: 'Directory path — resolved to projectId for type-based scope resolution.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'skill_submit_feedback',
    title: 'Submit Skill Feedback',
    description: 'Submit LLM feedback for a user-managed Helm skill after applying it. Stores stars, summary, optional improvement, and caller CLI attribution.',
    inputSchema: {
      type: 'object',
      properties: {
        skillId: { type: 'string' },
        stars: { type: 'number', minimum: 1, maximum: 5 },
        summary: { type: 'string' },
        improvement: { type: 'string' },
      },
      required: ['skillId', 'stars', 'summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'skill_get_feedback',
    title: 'Get Skill Feedback',
    description: 'Read the accumulated feedback for a Helm skill: useCount, avgRating, reviewCount, and every review (stars, summary, improvement, caller CLI, timestamp). Call this before editing a skill so the rewrite addresses what callers actually complained about.',
    inputSchema: {
      type: 'object',
      properties: {
        skillId: { type: 'string' },
      },
      required: ['skillId'],
      additionalProperties: false,
    },
  },
  {
    name: 'skill_clear_reviews',
    title: 'Clear Skill Reviews',
    description: 'Discard all reviews for a Helm skill, keeping its use count. Use this after rewriting a skill so the old ratings do not describe a version that no longer exists.',
    inputSchema: {
      type: 'object',
      properties: {
        skillId: { type: 'string' },
      },
      required: ['skillId'],
      additionalProperties: false,
    },
  },
  {
    name: 'skill_create',
    title: 'Create Skill',
    description: 'Create a user-managed Helm skill persisted in config/skills.yaml. Omit projectIds or set allProjects=true for a global skill.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        body: { type: 'string' },
        type: { type: 'string' },
        aiAmendable: { type: 'boolean' },
        allProjects: { type: 'boolean' },
        projectIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'skill_update',
    title: 'Update Skill',
    description: 'Update a user-managed Helm skill. Protected skills reject AI amendments unless aiAmendable is enabled.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        body: { type: 'string' },
        type: { type: 'string' },
        aiAmendable: { type: 'boolean' },
        allProjects: { type: 'boolean' },
        projectIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'skill_delete',
    title: 'Delete Skill',
    description: 'Delete a user-managed Helm skill by id. System skills cannot be deleted.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'plan_list',
    title: 'List Plans',
    description: "List plan items for a directory. Use this before editing or assigning plan work so you can reference the human-readable P-00xx plan IDs Helm returns. The optional filter narrows results: 'active' (default) omits completed plans; 'all' includes done plans; 'startable' returns only the dependency frontier — non-done plans whose precursors are all complete (or have none).",
    inputSchema: {
      type: 'object',
      properties: {
        dirPath: { type: 'string' },
        filter: { type: 'string', enum: ['all', 'active', 'startable'], description: "Which plans to include. Default 'active' (non-done). 'all' includes done; 'startable' = non-done plans with all precursors complete." },
      },
      required: ['dirPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'plan_summary',
    title: 'Plans Summary',
    description: "List plans for a directory as a compact summary — status, canonical ID, human-readable P-00xx ID, title, and dependency relationships. Call this first when orienting to a project so you know what work exists and what is blocked by what. Use plan_get for the full description of a specific plan before claiming, updating, or creating linked follow-ups. The optional filter narrows results: 'active' (default) omits completed plans; 'all' includes done plans; 'startable' returns only the dependency frontier — non-done plans whose precursors are all complete (or have none).",
    inputSchema: {
      type: 'object',
      properties: {
        dirPath: { type: 'string' },
        filter: { type: 'string', enum: ['all', 'active', 'startable'], description: "Which plans to include. Default 'active' (non-done). 'all' includes done; 'startable' = non-done plans with all precursors complete." },
      },
      required: ['dirPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'plan_get',
    title: 'Get Plan',
    description: 'Get a single plan item by UUID. Before implementation, use this with plan_context_list to inspect the plan and effective context refs; fetch full context just-in-time with context_get only when it is relevant to the current phase. To convert a P-00xx human-readable ID to UUID, use plan_get_id first.',
    inputSchema: {
      type: 'object',
      properties: { uuid: { type: 'string' } },
      required: ['uuid'],
      additionalProperties: false,
    },
  },
  {
    name: 'plan_get_id',
    title: 'Get Plan ID Conversion',
    description: 'Convert a P-00xx human-readable plan ID to its UUID. This is the ONLY tool that accepts P-nnnn format; all other plan_* tools require UUID only.',
    inputSchema: {
      type: 'object',
      properties: { humanId: { type: 'string' } },
      required: ['humanId'],
      additionalProperties: false,
    },
  },
  {
    name: 'plan_create',
    title: 'Create Plan',
    description: `Create a plan item in a directory when follow-up work, later cleanup, or a blocking question should survive the current session. Optionally set type to "bug", "feature", or "research", and set autoImplement=true when this ready follow-up may be picked up automatically after its prerequisite is completed. The description should include these sections: ${REQUIRED_PLAN_DESCRIPTION_SECTIONS.join(', ')}. For blocking questions, create a separate plan titled "QUESTION: ..." and link it to the original blocked plan with plan_nextplan_link so the question must be resolved first. The new plan starts in "planning" status with no session owner. When you begin working on this plan, call session_plan_claim with your sessionId and the planId to claim it.`,
    inputSchema: {
      type: 'object',
      properties: {
        dirPath: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        type: { type: 'string', enum: ['bug', 'feature', 'research'] },
        autoImplement: { type: 'boolean' },
      },
      required: ['dirPath', 'title', 'description'],
      additionalProperties: false,
    },
  },
  {
    name: 'plan_update',
    title: 'Update Plan',
    description: 'Update a plan item title, description, type, auto-implement flag, and/or completion recap flag by UUID. Set type to "bug", "feature", or "research"; pass null to clear the type. Set autoImplement true or false to control whether a ready follow-up plan may be picked up automatically after its prerequisite is completed. Set completionRecap true or false to control whether plan_complete runs the read-verification recap gate. Use plan_get_id to convert P-00xx format to UUID.',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        type: { anyOf: [{ type: 'string', enum: ['bug', 'feature', 'research'] }, { type: 'null' }] },
        autoImplement: { type: 'boolean' },
        completionRecap: { type: 'boolean' },
      },
      required: ['uuid'],
      additionalProperties: false,
    },
  },
  {
    name: 'plan_delete',
    title: 'Delete Plan',
    description: 'Delete a plan item by UUID. Use plan_get_id to convert P-00xx format to UUID.',
    inputSchema: {
      type: 'object',
      properties: { uuid: { type: 'string' } },
      required: ['uuid'],
      additionalProperties: false,
    },
  },
  {
    name: 'plan_set_state',
    title: 'Set Plan State',
    description: 'Set a plan item state by UUID to planning, ready, coding, review, or blocked. Use this when the lifecycle state itself changed. Use plan_get_id to convert P-00xx format to UUID.',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string' },
        status: { type: 'string', enum: ['planning', 'ready', 'coding', 'review', 'blocked'] },
        stateInfo: { type: 'string' },
        sessionId: { type: 'string' },
      },
      required: ['uuid', 'status'],
      additionalProperties: false,
    },
  },
  {
    name: 'plan_complete',
    title: 'Complete Plan',
    description: 'Mark a coding or review plan item as done by UUID. Requires documentation of what was done (minimum 10 characters). Good completion notes summarize implemented behavior, important files changed, tests or review performed, and any remaining risk. Use plan_get_id to convert P-00xx format to UUID.',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string' },
        documentation: { type: 'string', description: 'Documentation of what was accomplished (minimum 10 characters)' },
      },
      required: ['uuid', 'documentation'],
      additionalProperties: false,
    },
  },
  {
    name: 'plan_reopen',
    title: 'Reopen Plan',
    description: 'Revert a done plan back to ready or planning by UUID based on its current dependencies. Use this to undo an accidental plan_complete call. The plan\'s sessionId is cleared on reopen. Use plan_get_id to convert P-00xx format to UUID.',
    inputSchema: {
      type: 'object',
      properties: { uuid: { type: 'string' } },
      required: ['uuid'],
      additionalProperties: false,
    },
  },
  {
    name: 'plan_context_list',
    title: 'List Effective Plan Context',
    description: 'List the effective context refs for one plan by UUID or P-00xx human-readable ID. This merges direct plan context plus inherited parent-sequence context into one deduped set, with source telling you whether each context comes from the plan, the sequence, or both. Use this before implementing a plan, then call context_get just-in-time only for contexts relevant to the current phase; defer unrelated context such as testing notes until that phase.',
    inputSchema: {
      type: 'object',
      properties: { planId: { type: 'string' } },
      required: ['planId'],
      additionalProperties: false,
    },
  },
  {
    name: 'plan_nextplan_link',
    title: 'Link Next Plan',
    description: 'Link one plan item as a prerequisite for another by UUID. A plan can have many outgoing links (to many next plans) and many incoming links (from many previous plans). The source plan must complete before the target plan can start. Use this for blocking questions by linking the separate QUESTION plan to the original blocked plan. Use plan_get_id to convert P-00xx format to UUID.',
    inputSchema: {
      type: 'object',
      properties: {
        fromId: { type: 'string' },
        toId: { type: 'string' },
      },
      required: ['fromId', 'toId'],
      additionalProperties: false,
    },
  },
  {
    name: 'plan_nextplan_unlink',
    title: 'Unlink Next Plan',
    description: 'Remove a prerequisite link between two plan items by UUID. Use plan_get_id to convert P-00xx format to UUID.',
    inputSchema: {
      type: 'object',
      properties: {
        fromId: { type: 'string' },
        toId: { type: 'string' },
      },
      required: ['fromId', 'toId'],
      additionalProperties: false,
    },
  },
  {
    name: 'sequence_list',
    title: 'List Sequences',
    description: 'List sequence coordination lanes for a directory, or for a specific plan by UUID/P-id. Returned sharedMemory is legacy common memory for member plans; prefer context_* tools for new durable memory and use expectedUpdatedAt on writes to avoid concurrent overwrite.',
    inputSchema: {
      type: 'object',
      properties: {
        dirPath: { type: 'string' },
        planId: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'sequence_get',
    title: 'Get Sequence',
    description: 'Get one sequence coordination lane by ID, including its legacy sharedMemory.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'sequence_create',
    title: 'Create Sequence',
    description: 'Create a first-class sequence coordination lane in a directory. Plans can be assigned to it with sequence_assign; prefer context_* tools over sharedMemory for new durable notes.',
    inputSchema: {
      type: 'object',
      properties: {
        dirPath: { type: 'string' },
        title: { type: 'string' },
        missionStatement: { type: 'string' },
        sharedMemory: { type: 'string' },
      },
      required: ['dirPath', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'sequence_update',
    title: 'Update Sequence',
    description: 'Update sequence title, mission, sharedMemory, or order. sharedMemory is a legacy coordination field; prefer context_* tools for new durable memory. Pass expectedUpdatedAt from sequence_list/get-style responses for mutex-style protection against concurrent LLM writes.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        missionStatement: { type: 'string' },
        sharedMemory: { type: 'string' },
        order: { type: 'number' },
        expectedUpdatedAt: { type: 'number' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'sequence_delete',
    title: 'Delete Sequence',
    description: 'Delete a sequence/shared-memory store and clear sequence membership from its member plans.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'sequence_assign',
    title: 'Assign Sequence',
    description: 'Assign a plan by UUID/P-id to a sequence in the same directory, or pass null sequenceId to unlink the plan from its sequence without deleting the sequence.',
    inputSchema: {
      type: 'object',
      properties: {
        planId: { type: 'string' },
        sequenceId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: ['planId', 'sequenceId'],
      additionalProperties: false,
    },
  },
  {
    name: 'context_list',
    title: 'List Context Nodes',
    description: 'List project-level context nodes. Use project_list first when you need the projectId for a directory or repo.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
  },
  {
    name: 'context_create',
    title: 'Create Context Node',
    description: 'Create a project-level context node. Context nodes can later be associated with plans or sequences, while agents retrieve the full content through context_get only when needed.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        title: { type: 'string' },
        type: { type: 'string' },
        permission: { type: 'string', enum: ['readonly', 'writable'] },
        content: { type: 'string' },
        x: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        y: { anyOf: [{ type: 'number' }, { type: 'null' }] },
      },
      required: ['projectId', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'context_update',
    title: 'Update Context Node',
    description: 'Update a context node by ID. This can change the title, free-text type, permission mode, content, or stored position. Pass expectedUpdatedAt from the last read to enforce mutex-safe writes and reject stale updates.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        type: { type: 'string' },
        permission: { type: 'string', enum: ['readonly', 'writable'] },
        content: { type: 'string' },
        x: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        y: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        expectedUpdatedAt: { type: 'number' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'context_delete',
    title: 'Delete Context Node',
    description: 'Delete a context node by ID and remove all of its plan and sequence bindings.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'context_get',
    title: 'Get Context Node',
    description: 'Fetch a context node by ID, including full content. Use this after inspecting plan_context_list or context_list.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'context_set_position',
    title: 'Set Context Position',
    description: 'Persist the X/Y canvas position for a context node so user-placed context cards stay where they were dragged.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        x: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        y: { anyOf: [{ type: 'number' }, { type: 'null' }] },
      },
      required: ['id', 'x', 'y'],
      additionalProperties: false,
    },
  },
  {
    name: 'context_bind',
    title: 'Bind Context Node',
    description: 'Associate an existing context node with a plan or sequence in the same directory so it appears in effective plan/sequence context lists.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        targetType: { type: 'string', enum: ['sequence', 'plan'] },
        targetId: { type: 'string' },
      },
      required: ['id', 'targetType', 'targetId'],
      additionalProperties: false,
    },
  },
  {
    name: 'context_unbind',
    title: 'Unbind Context Node',
    description: 'Remove one plan or sequence association from an existing context node without deleting the context itself.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        targetType: { type: 'string', enum: ['sequence', 'plan'] },
        targetId: { type: 'string' },
      },
      required: ['id', 'targetType', 'targetId'],
      additionalProperties: false,
    },
  },
  {
    name: 'plan_attachment_list',
    title: 'List Plan Attachments',
    description: 'List files attached to a plan by UUID. Attachments are stored inside Helm config, not as fragile external references. Use plan_get_id to convert P-00xx format to UUID.',
    inputSchema: {
      type: 'object',
      properties: {
        planId: { type: 'string' },
      },
      required: ['planId'],
      additionalProperties: false,
    },
  },
  {
    name: 'plan_attachment_add',
    title: 'Add Plan Attachment',
    description: 'Attach an existing file to a plan by providing its local file path. The path is resolved on the Helm instance handling the call (for peer calls, the receiving instance). The caller owns the source file: Helm reads and copies it but never deletes or modifies it. The stored copy is owned by Helm in Helm config-managed storage and remains until plan_attachment_delete or plan deletion. Use plan_get_id to convert P-00xx format to UUID.',
    inputSchema: {
      type: 'object',
      properties: {
        planId: { type: 'string', description: 'Plan UUID or P-00xx human-readable ID' },
        filePath: { type: 'string', description: 'Absolute path to the file to attach' },
        contentType: { type: 'string', description: 'Optional MIME content type' },
      },
      required: ['planId', 'filePath'],
      additionalProperties: false,
    },
  },
  {
    name: 'plan_attachment_delete',
    title: 'Delete Plan Attachment',
    description: 'Delete a stored attachment from a plan by UUID and attachmentId. Helm deletes its managed copy; this does not affect the caller-owned source file originally supplied to plan_attachment_add. Use plan_get_id to convert P-00xx format to UUID.',
    inputSchema: {
      type: 'object',
      properties: {
        planId: { type: 'string' },
        attachmentId: { type: 'string' },
      },
      required: ['planId', 'attachmentId'],
      additionalProperties: false,
    },
  },
  {
    name: 'plan_attachment_get',
    title: 'Get Plan Attachment Temp File',
    description: 'Copy a stored attachment to a Helm temp file and return the tempPath plus metadata. The returned temp file is caller-owned for use and must be deleted promptly after reading; Helm may reap stale Helm-owned temp files on startup. This avoids inline raw or base64 content in MCP responses. Use plan_get_id to convert P-00xx format to UUID.',
    inputSchema: {
      type: 'object',
      properties: {
        planId: { type: 'string' },
        attachmentId: { type: 'string' },
      },
      required: ['planId', 'attachmentId'],
      additionalProperties: false,
    },
  },
  {
    name: 'directory_list',
    title: 'List Directories',
    description: 'List all directories that Helm knows about: configured folders plus directories that currently have plans or sessions. Alternate folders remain separate selectable dirPath entries while sharing projectId when they belong to the same project.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'project_create',
    title: 'Create Project',
    description: 'Register a new project (working directory) so it becomes a valid target for plan_create, sequence_create, and context_create. The directory must exist on disk and must not already be registered (as a canonical or alternate path). Changes are persisted immediately. Note: the running app loads projects once at startup — a restart_helm may be required before the new directory is accepted by other tools.',
    inputSchema: {
      type: 'object',
      properties: {
        dirPath: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['dirPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'project_rename',
    title: 'Rename Project',
    description: 'Change the display name of an existing project by its ID. Changes are persisted immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['projectId', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'project_delete',
    title: 'Delete Project',
    description: 'Remove a project registration by its ID. This deletes only the Helm project record (working-directory registration); it does not touch files on disk. Changes are persisted immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
  },
  {
    name: 'project_list',
    title: 'List Projects',
    description: 'List all known projects with their IDs, names, canonical paths, directories, and root kinds. Call this before creating plans or sessions to discover which project directories Helm tracks.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'project_dir_list',
    title: 'List Project Directories',
    description: 'List all directories (canonical and alternate) for a project by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
      },
      required: ['projectId'],
      additionalProperties: false,
    },
  },
  {
    name: 'project_dir_add',
    title: 'Add Project Directory',
    description: 'Add an alternate directory path to a project. The directory must not be the canonical path. Changes are persisted immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        dirPath: { type: 'string' },
      },
      required: ['projectId', 'dirPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'project_dir_remove',
    title: 'Remove Project Directory',
    description: 'Remove an alternate directory path from a project. Cannot remove the canonical path. Changes are persisted immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        dirPath: { type: 'string' },
      },
      required: ['projectId', 'dirPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'session_create',
    title: 'Create Session',
    description: 'Spawn a new CLI session in a configured working directory and give it a stable display name for later lookup. Call this when no suitable session exists yet and you need Helm to launch one. After spawning, wait readyAfterMs before calling session_send_text to deliver the first prompt — this ensures the CLI has finished its init sequence and large text is routed safely through the delivery pipeline. A session is always made for its project (dirPath); a runtime group is an optional overlay. runtimeGroupId: omit to inherit YOUR (the creator\'s) runtime group when you are in one, pass a group id (from session_group_list / session_group_create) to place it in a specific group, or "none" to force project-only placement. The result echoes runtimeGroupId/runtimeGroupName when the session landed in a group.',
    inputSchema: {
      type: 'object',
      properties: {
        cliType: { type: 'string' },
        dirPath: { type: 'string' },
        name: { type: 'string' },
        runtimeGroupId: { type: 'string' },
      },
      required: ['cliType', 'dirPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'session_group_list',
    title: 'List Session Groups',
    description: 'List runtime session groups — the user-created, cross-directory overlay grouping. Each group has an id, name, member sessionIds, and collapsed flag. Use the ids here to place sessions with session_create runtimeGroupId or session_group_add. Directory/project grouping is not a runtime group and is listed via directory_list / project_list / session_list instead.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'session_group_create',
    title: 'Create Session Group',
    description: 'Create a new empty runtime session group and return its id. Add sessions with session_group_add or by passing the id to session_create runtimeGroupId.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'session_group_add',
    title: 'Add Session To Group',
    description: 'Add a session to a runtime group by group id and session id (or exact display name). Membership is exclusive — the session is moved out of any other runtime group it was in.',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'string' },
        sessionId: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['groupId'],
      additionalProperties: false,
    },
  },
  {
    name: 'session_group_remove',
    title: 'Remove Session From Group',
    description: 'Remove a session from whichever runtime group it belongs to (identified by session id or exact display name). The session remains under its project.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        name: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'session_group_rename',
    title: 'Rename Session Group',
    description: 'Rename a runtime session group by id.',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['groupId', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'session_group_close',
    title: 'Close Session Group',
    description: 'Delete a runtime session group by id. Member sessions are not closed — they fall back to their project/directory grouping.',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'string' },
      },
      required: ['groupId'],
      additionalProperties: false,
    },
  },
  {
    name: 'session_list',
    title: 'List Sessions',
    description: 'List currently known Helm sessions, optionally filtered to one working directory or project. Call this before sending text so you can target an existing session instead of spawning blindly.',
    inputSchema: {
      type: 'object',
      properties: {
        dirPath: { type: 'string' },
        projectId: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'session_get',
    title: 'Get Session',
    description: 'Get one Helm session by session ID or exact display name. Use this when you need session details, including its current working-plan pointer, before deciding what to send or update.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        name: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'session_send_text',
    title: 'Send Text To Session',
    description:
      'Send text to a running session PTY. ' +
      'DESTINATION: Provide sessionId (the target session that will receive the text). ' +
      'SENDER: Provide senderSessionId (your own session ID from the HELM_SESSION_ID env var). ' +
      'IMPORTANT: Destination and sender MUST be different sessions — self-messages are rejected. ' +
      'Text is always submitted atomically (Enter is appended automatically). ' +
      'After every inter-LLM send, call session_read_terminal on the recipient and verify the terminal tail shows the first words of the sent text, a new prompt, or a response starting; warn the user if no receipt evidence is visible. ' +
      'Optional expectsResponse marks HELM inter-LLM envelopes that expect a reply. ' +
      'RECEIVING RESPONSES: When the target session replies, Helm pastes a [HELM_MSG] envelope directly into the sender session\'s chatbox as a new user message — there is no polling or callback; the reply arrives as an inbound chat turn in your own session.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: '[DESTINATION] Target session ID — MUST be different from senderSessionId.',
        },
        text: { type: 'string' },
        senderSessionId: {
          type: 'string',
          description:
            '[SENDER] Your session ID — MUST equal the HELM_SESSION_ID environment variable injected by Helm at startup. ' +
            'Retrieve it with `echo $HELM_SESSION_ID` (bash) or read process.env.HELM_SESSION_ID (Node.js). ' +
            'IMPORTANT: must be DIFFERENT from the destination sessionId.',
        },
        expectsResponse: { type: 'boolean', default: false },
      },
      required: ['text', 'sessionId', 'senderSessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'session_send_input',
    title: 'Send Terminal Input To Session',
    description:
      'Send sequence-style terminal input to a running session PTY without HELM_MSG preamble. ' +
      'Use this for TUI/terminal automation: navigating menus, pressing keys, typing text. ' +
      'DESTINATION: Provide sessionId (the target session that will receive the input). ' +
      'SENDER: Provide senderSessionId (your own session ID from the HELM_SESSION_ID env var). ' +
      'IMPORTANT: Destination and sender MUST be different sessions — self-send is rejected. ' +
      'Supports sequence syntax: {Esc}, {Tab}, {Enter}, {ArrowDown}, {Ctrl+C}, {Wait 200}, literal text. ' +
      'No implicit Enter is appended unless impliedSubmit=true or the sequence includes {Enter}/{Send}. ' +
      'After sending input, call session_read_terminal on the recipient to verify the input was received.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: '[DESTINATION] Target session ID — MUST be different from senderSessionId.',
        },
        senderSessionId: {
          type: 'string',
          description:
            '[SENDER] Your session ID — MUST equal the HELM_SESSION_ID environment variable injected by Helm at startup.',
        },
        sequence: {
          type: 'string',
          description: 'Sequence-parser syntax to send: {Esc}, {Tab}, {Enter}, {ArrowDown}, {Ctrl+C}, {Wait 200}, literal text.',
        },
        impliedSubmit: { type: 'boolean', default: false },
        verify: { type: 'boolean', default: true },
      },
      required: ['sessionId', 'senderSessionId', 'sequence'],
      additionalProperties: false,
    },
  },
  {
    name: 'session_clear',
    title: 'Clear Session Context',
    description:
      'Reset a target session by delivering its configured clear command into its PTY, then optionally relay a ' +
      '"note to future self" so the freshly-cleared session keeps what matters. ' +
      'The clear sequence comes from the CLI config helmActions.clear (falling back to legacy clearCommand, then "/clear"). ' +
      'DESTINATION: sessionId is REQUIRED — the session to clear (may be your own or a worker you manage). ' +
      'The optional context note is delivered as a new prompt after the clear settles; large notes are written to a Helm ' +
      'temp file and a read-the-file notice is pasted instead. ' +
      'The CLI processes the clear asynchronously — wait ~1 min before reading results.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: '[DESTINATION] Target session ID to clear (required).',
        },
        context: {
          type: 'string',
          description:
            'Optional note relayed to the freshly-cleared session — outstanding work, decisions, file paths, next steps. ' +
            'Omit to clear with no follow-up.',
        },
        senderSessionId: {
          type: 'string',
          description:
            '[OPTIONAL] Your session ID for audit — defaults to the HELM_SESSION_ID identity injected by Helm.',
        },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'session_compact',
    title: 'Compact Session Context',
    description:
      'Compact a target session by delivering its configured compact command into its PTY. ' +
      'The sequence comes from the CLI config helmActions.compact, where the $instruction placeholder is replaced with ' +
      'the optional instruction you supply (e.g. "/compact $instruction"). ' +
      'DESTINATION: sessionId is REQUIRED. Returns an error if the target CLI has no compact action configured. ' +
      'The CLI processes the compaction asynchronously — wait ~1 min before reading results. ' +
      'Pass "handover" to have a note pasted back automatically once the compaction settles — this is how a session ' +
      'compacting ITSELF carries working state across the discard.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: '[DESTINATION] Target session ID to compact (required).',
        },
        instruction: {
          type: 'string',
          description:
            'Optional focus for the compaction, substituted into the CLI command\'s $instruction placeholder. ' +
            'Omit if the configured command takes no argument.',
        },
        handover: {
          type: 'string',
          description:
            'Optional note to your post-compaction self, pasted into the session automatically once it falls quiet. ' +
            'Write it BEFORE compacting, while you still remember: what you were doing, decisions already made, ' +
            'files touched, the next concrete step, and any open question. ' +
            'The content is opaque to Helm — inline prose, a file path, or an artifact reference all work, ' +
            'so keep it short and point at detail you have stored elsewhere if it is long. ' +
            'The call returns immediately; delivery happens later.',
        },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'session_export',
    title: 'Export Session To File',
    description:
      'Export a target session\'s detail to a file by delivering its configured export command into its PTY. ' +
      'The sequence comes from the CLI config helmActions.export, where the $path placeholder is replaced with the ' +
      'caller-supplied path (e.g. "/export $path"). The CLI itself writes the file; Helm only supplies the path and ' +
      'echoes it back in the result. Use this to harvest an old session\'s knowledge into a temp file WITHOUT paying to ' +
      'reactivate it. DESTINATION: sessionId is REQUIRED. Returns an error if the target CLI has no export action configured. ' +
      'The CLI writes the file asynchronously — wait ~1 min, then read the file at the returned path.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: '[DESTINATION] Target session ID to export (required).',
        },
        path: {
          type: 'string',
          description: 'Absolute file path the CLI should write the export to, substituted into the $path placeholder (required).',
        },
      },
      required: ['sessionId', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'session_read_terminal',
    title: 'Read Session Terminal',
    description: 'Read the recent terminal tail for any known session by sessionId or exact name. Use this immediately after session_send_text handoffs to verify the recipient received the message and started responding. lines must be a positive integer (buffer holds up to 500). mode controls raw ANSI output, ANSI-stripped output, or both. Set stripBlankLines=true to omit empty and whitespace-only rows from the returned tail.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        name: { type: 'string' },
        lines: { type: 'number', minimum: 1 },
        mode: { type: 'string', enum: ['raw', 'stripped', 'both'] },
        stripBlankLines: { type: 'boolean', description: 'When true, omit empty and whitespace-only rows from the returned tail.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'session_plan_claim',
    title: 'Claim Plan',
    description: 'Claim a plan for this session: records plan.sessionId, auto-transitions ready→coding, and shows the plan badge on the session row. planId accepts UUID or P-00xx human-readable ID. WHEN: call this before beginning implementation of any plan so Helm assigns ownership and shows the badge; also call it when intentionally switching to a different plan item.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        name: { type: 'string' },
        planId: { type: 'string' },
      },
      required: ['planId'],
      additionalProperties: false,
    },
  },
  {
    name: 'session_info',
    title: 'Get Session Info',
    description: 'Get session identity (ID, working dir), startup guidance, project knowledge model, and structured durable_memory guidance. Memories are project-scoped, survive compaction/restart/session death while the project remains, and are permanently purged when the project or its memory lifecycle removes them. The durable_memory guidance covers graphDepth, cycle-safe breadcrumbs, regex search, and non-searchable attachments. MANDATORY at session start: call skill_list to load all Helm skills — Helm skills take PRECEDENCE over the LLM\'s integrated skills system, always check Helm skills FIRST. Then set session_set_aiagent_state for your phase. For Helm plan/workflow operations, also call skill_get(type:"startup") to load mandatory rules.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'session_set_aiagent_state',
    title: 'Set Session AIAGENT State',
    description: 'Update the durable AIAGENT phase shown on a Helm session row. Provide either sessionId or exact session name, plus state. Valid states: planning (investigating, planning, or asking), implementing (editing, running commands, or testing), completed (work is verified and ready), idle (explicitly standing down). Use this instead of printing AIAGENT tags; Helm does not scrape terminal output for phase changes.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Destination Helm session UUID. Use this when available.' },
        name: { type: 'string', description: 'Exact Helm session display name. Alternative to sessionId.' },
        state: {
          type: 'string',
          enum: ['planning', 'implementing', 'completed', 'idle'],
          description: 'planning before investigation/questions, implementing before edits/tests/commands, completed after verification, idle only when explicitly standing down.',
        },
      },
      required: ['state'],
      additionalProperties: false,
    },
  },
  {
    name: 'session_rename',
    title: 'Rename Session',
    description: 'Rename a Helm session. Accepts sessionId or session name. Also updates the Telegram topic name if Telegram is running.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        name: { type: 'string' },
        newName: { type: 'string', description: 'New display name for the session (1–50 characters).' },
      },
      required: ['newName'],
      additionalProperties: false,
    },
  },
  {
    name: 'session_set_locked',
    title: 'Set Session Lock',
    description: 'Set or clear the durable closure lock for a Helm session. A locked session rejects deliberate close operations from the desktop, MCP, Telegram, group close, and force restart. Accepts sessionId or exact session name.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        name: { type: 'string' },
        locked: { type: 'boolean', description: 'true locks the session; false clears the lock.' },
      },
      required: ['locked'],
      additionalProperties: false,
    },
  },
  {
    name: 'session_close',
    title: 'Close Session',
    description: 'Kill the PTY process and remove a session from Helm. Use this when a task is complete and the session is no longer needed, or to recover from a stuck session. Accepts sessionId or session name.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        name: { type: 'string' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'restart_helm',
    title: 'Restart Helm',
    description: 'Restart the Helm application. By default sessions are preserved and auto-resume after relaunch. Pass resume:false to close all sessions first (force restart). MCP and Telegram resume after a 3-second delay. REQUIRED: pass resumePrompt — a compact handover to your post-restart self (what was being done, decisions made, the next concrete step). Helm creates a one-shot scheduled task that re-prompts this session ~2 minutes after relaunch, so the restart never strands your work. Returns the resumeTaskId so you can scheduler_cancel it if the restart turns out unnecessary.',
    inputSchema: {
      type: 'object',
      properties: {
        resume: { type: 'boolean', description: 'Preserve and auto-resume existing sessions after relaunch. Defaults to true; set false to close all sessions first. resumePrompt is not allowed with resume:false — the calling session is closed and cannot be re-prompted.' },
        resumePrompt: { type: 'string', description: 'Handover delivered back to this session after relaunch: what was in flight, key decisions, and the next concrete step.' },
      },
      required: ['resumePrompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'notify_user',
    title: 'Notify User',
    description: 'Send an LLM-directed notification with smart delivery routing. Provide sessionId or exact session name. Call on work completion, when blocked waiting for user input, or when an error stops progress. Helm routes to toast, taskbar flash, bubble, or Telegram based on screen/window state. Returns delivered channel.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Target Helm session ID. Provide this or name.' },
        name: { type: 'string', description: 'Exact target Helm session name. Provide this or sessionId.' },
        title: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['title', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'flash_attention',
    title: 'Flash Session For Attention',
    description: 'Grab the user\'s attention by flashing a session in the Helm sidebar. The session card beats between its normal background and the Windows theme accent colour for 15 seconds, then holds the accent colour until the user focuses the session. If the session\'s directory group is collapsed, the group header flashes instead. Use this when you need the user to look at a specific session — e.g. you are blocked waiting for input or a long task just finished. Provide sessionId or exact session name.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Target Helm session ID. Provide this or name.' },
        name: { type: 'string', description: 'Exact target Helm session name. Provide this or sessionId.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_app_visibility',
    title: 'Get App Visibility',
    description: 'Return the current app visibility/focus bucket, screen-lock state, and activeSessionId for notification routing decisions.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_status',
    title: 'Telegram Status',
    description: 'Report whether Telegram is enabled, configured, running, and available. Agents should use Telegram only for concise mobile-friendly urgent blockers or after the user has already engaged through Telegram. No bot token is returned.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_chat',
    title: 'Send Telegram Chat',
    description: 'Send concise mobile-friendly text to the user via Telegram. Replies always go to YOUR OWN session topic (resolved from the X-Helm-Session-Id header); you do not need to pass sessionId. sessionId is an optional override for global-token callers. Resolving by name is not supported — duplicate names would mis-route. Lines must be short; do not send large wide logs, tables, or code blocks.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Optional override — your own session UUID. Normally omit it; the server uses your authenticated identity.' },
        message: { type: 'string' },
        filePath: { type: 'string', description: 'Optional absolute file path to send as attachment. System reads file from disk.' },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_send_voice',
    title: 'Send Telegram Voice Reply',
    description: 'Helm synthesizes speech (piper→ffmpeg→OGG/Opus) and sends it as a native Telegram voice message to YOUR session topic. TEXT IS THE DEFAULT REPLY CHANNEL — only use voice when the user explicitly asks for a voice reply. Only available when piper+ffmpeg are configured.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Optional override — your own session UUID. Normally omit it; the server uses your authenticated identity.' },
        text: { type: 'string', description: 'The text Helm will speak. Keep it concise and mobile-friendly.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'telegram_channel_close',
    title: 'Close Telegram Channel',
    description: 'Close one MCP Telegram communication channel without deleting unrelated session topics.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
      },
      required: ['channelId'],
      additionalProperties: false,
    },
  },
  {
    name: 'scheduler_create',
    title: 'Create Scheduler Entry',
    description: 'Create a scheduled task. Use mode "spawn" to launch a CLI session, or "direct" to send a prompt to an existing session. For a self-timer, pass targetSession:"caller"; Helm resolves the authenticated creating session and stores its ID durably. Use scheduleKind "once", "interval" (min 1 minute interval), or "cron" with a cronExpression. scheduledTime is an ISO 8601 date string.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title' },
        description: { type: 'string', description: 'Optional task description' },
        initialPrompt: { type: 'string', description: 'Prompt to send to the CLI session' },
        cliType: { type: 'string', description: 'CLI type id or display name to spawn. Required for mode "spawn"; ignored for mode "direct", which inherits the target session\'s type.' },
        dirPath: { type: 'string', description: 'Working directory for the session' },
        scheduledTime: { type: 'string', description: 'ISO 8601 datetime for first execution' },
        scheduleKind: { type: 'string', enum: ['once', 'interval', 'cron'], description: 'once, interval, or cron (default: once)' },
        intervalMs: { type: 'number', description: 'Interval in ms for recurring tasks (min 60000)' },
        cronExpression: { type: 'string', description: 'Cron expression for cron schedules, e.g. 0 9 * * 1-5' },
        endDate: { type: 'string', description: 'Optional ISO 8601 end date for cron schedules' },
        planIds: { type: 'array', items: { type: 'string' }, description: 'Associated plan IDs' },
        mode: { type: 'string', enum: ['spawn', 'direct'], description: 'spawn new session or send to existing (default: spawn)' },
        targetSessionId: { type: 'string', description: 'Session ID for direct mode' },
        targetSession: { type: 'string', enum: ['caller'], description: 'For direct mode, target the authenticated session that creates this schedule.' },
      },
      required: ['title', 'initialPrompt', 'dirPath', 'scheduledTime'],
      additionalProperties: false,
    },
  },
  {
    name: 'scheduler_list',
    title: 'List Scheduler Entries',
    description: 'List all scheduled tasks.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'scheduler_get',
    title: 'Get Scheduler Entry',
    description: 'Get a scheduled task by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task ID' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'scheduler_update',
    title: 'Update Scheduler Entry',
    description: 'Update a pending scheduled task. Only pending tasks can be updated. scheduledTime is an ISO 8601 date string.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task ID' },
        title: { type: 'string' },
        description: { type: 'string' },
        initialPrompt: { type: 'string' },
        cliType: { type: 'string' },
        dirPath: { type: 'string' },
        scheduledTime: { type: 'string', description: 'ISO 8601 datetime' },
        scheduleKind: { type: 'string', enum: ['once', 'interval', 'cron'] },
        intervalMs: { type: 'number' },
        cronExpression: { type: 'string' },
        endDate: { type: 'string' },
        planIds: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string', enum: ['spawn', 'direct'] },
        targetSessionId: { type: 'string' },
        targetSession: { type: 'string', enum: ['caller'], description: 'Replace the direct target with the authenticated calling session.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'scheduler_cancel',
    title: 'Cancel Scheduler Entry',
    description: 'Cancel a pending scheduled task. Only pending tasks can be cancelled.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task ID' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'scheduler_delete',
    title: 'Delete Scheduler Entry',
    description: 'Delete a scheduled task and cancel its pending run.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Task ID' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'artifact_create',
    title: 'Create Artifact',
    description:
      'Create a NEW readable report artifact for THIS session and show it in the user\'s in-app Artifact panel. Provide either inline content (title, kind, content) or an absolute local filePath. The path is resolved on the Helm instance handling the call (for peer calls, the receiving instance). For filePath, the caller owns the source file: Helm reads it during the call and never deletes or modifies it. Text files become readable markdown; binary files are stored as Helm-owned attachments. Returns the new artifact including its id. Auto-reveals (brings it forward) so the user sees it immediately. Ephemeral: artifacts belong to this session and are discarded when it closes. The session is resolved from your auth context — no sessionId argument.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Display title for the artifact.' },
        kind: { type: 'string', enum: ['markdown', 'html'], description: 'Renderable content kind.' },
        content: { type: 'string', description: 'The artifact body (markdown or HTML source).' },
        filePath: { type: 'string', description: 'Absolute path to an existing source file. Caller owns this file; Helm reads it but never deletes or modifies it.' },
        contentType: { type: 'string', description: 'Optional MIME type for filePath input.' },
      },
      oneOf: [
        { required: ['title', 'kind', 'content'], not: { required: ['filePath'] } },
        { required: ['filePath'], not: { required: ['content'] } },
      ],
      additionalProperties: false,
    },
  },
  {
    name: 'artifact_update',
    title: 'Update Artifact',
    description:
      'Append a NEW version to an existing artifact you created and bring it forward in the viewer. Provide either inline content or an absolute local filePath. The path is resolved on the Helm instance handling the call (for peer calls, the receiving instance). For filePath, the caller owns the source file: Helm reads it during the call and never deletes or modifies it. Text files become the new readable version; binary files create a new Helm-owned attachment and metadata-card version. Prior versions and attachments are retained. Returns the updated artifact. Use for user-facing content only, not code.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The artifact id to revise.' },
        content: { type: 'string', description: 'The new full content body (becomes the latest version).' },
        filePath: { type: 'string', description: 'Absolute path to an existing source file. Caller owns this file; Helm reads it but never deletes or modifies it.' },
        contentType: { type: 'string', description: 'Optional MIME type for filePath input.' },
      },
      required: ['id'],
      oneOf: [
        { required: ['content'], not: { required: ['filePath'] } },
        { required: ['filePath'], not: { required: ['content'] } },
      ],
      additionalProperties: false,
    },
  },
  {
    name: 'artifact_show',
    title: 'Show Artifact',
    description:
      'Bring an existing artifact forward in the user\'s in-app viewer without changing its content. Use to re-surface a report/analysis you already created so the user looks at it again.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The artifact id to reveal.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'artifact_delete',
    title: 'Delete Artifact',
    description: 'Delete a single artifact by id from this session\'s in-app Artifact panel. Helm also deletes the artifact\'s managed attachment copies; it never deletes the caller-owned source files supplied through filePath.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The artifact id to delete.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'artifact_delete_all',
    title: 'Delete All Artifacts',
    description: 'Clear ALL artifacts for THIS session (resolved from your auth context). Helm also deletes their managed attachment copies; it never deletes caller-owned source files supplied through filePath. Use to tidy up the panel when your reports are no longer needed.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'artifact_list',
    title: 'List Artifacts',
    description:
      'List THIS session\'s artifacts (resolved from your auth context) so you can see the reports/analyses you have already produced. Returns id, title, kind, version count, and timestamps for each — call artifact_get(id) to re-read full content.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'artifact_get',
    title: 'Get Artifact',
    description:
      'Re-read one of your own artifacts by id. Returns the latest version by default, or the given version number\'s content. Use asFile=true to materialize the selected artifact source to a Helm temp path, or provide attachmentId to materialize an original binary attachment. The returned tempPath is on the Helm instance handling the call (for peer calls, the receiving instance), is caller-owned for use, and must be deleted promptly; Helm may reap stale Helm-owned temp files on startup. Use this to recover the content of a report/analysis you authored earlier this session.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The artifact id to read.' },
        version: { type: 'number', description: 'Optional 1-based version number; omit for the latest.' },
        asFile: { type: 'boolean', description: 'Write the selected artifact source to a Helm temp file and return tempPath. Caller must delete tempPath after use.' },
        attachmentId: { type: 'string', description: 'Materialize this original binary attachment to tempPath. Caller must delete tempPath after use.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_dream',
    title: 'Dream Memories',
    description: 'Return bounded, disjoint faded and salient candidates from the project resolved from the authenticated caller session. This tool only identifies candidates; it never decides what to forget or merge.',
    inputSchema: {
      type: 'object',
      properties: {
        percentile: { type: 'number', exclusiveMinimum: 0, maximum: 100 },
        minCandidates: { type: 'integer', minimum: MEMORY_DREAM_MIN_CANDIDATES, maximum: MEMORY_DREAM_MAX_CANDIDATES },
        maxCandidates: { type: 'integer', minimum: MEMORY_DREAM_MIN_CANDIDATES, maximum: MEMORY_DREAM_MAX_CANDIDATES },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'memory_set_dormant',
    title: 'Set Memory Dormant',
    description: 'Mark a memory in the project resolved from the authenticated caller session as dormant or active. Dormant memories are hidden from normal recall and can be restored by reading them.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        dormant: { type: 'boolean' },
      },
      required: ['id', 'dormant'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_list',
    title: 'List Memories',
    description: 'List durable memories for the project resolved from the authenticated caller session. Memories survive compaction, restart, and session death while the project remains; attachments are returned as metadata only. Optional sortBy/order rank them for trimming; memories never read (or never matched) sort last rather than oldest.',
    inputSchema: {
      type: 'object',
      properties: {
        sortBy: {
          type: 'string',
          enum: ['created', 'updated', 'accessed'],
          description: 'Timestamp to rank by. Defaults to insertion order.',
        },
        order: {
          type: 'string',
          enum: ['asc', 'desc'],
          description: 'Defaults to desc (most recent first).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'memory_get',
    title: 'Get Memory',
    description: 'Get a project memory resolved from the authenticated caller session and its cycle-safe graph neighborhood. Optional graphDepth adds breadcrumbed record/reference/cycle/depth-limit entries.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        graphDepth: { type: 'integer', minimum: 0, maximum: 100 },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_create',
    title: 'Create Memory',
    description: 'Create a durable memory in the project resolved from the authenticated caller session. Project ownership is derived from authContext.sessionId, never from caller input.',
    inputSchema: {
      type: 'object',
      properties: {
        tldr: { type: 'string', minLength: 1 },
        content: { type: 'string' },
      },
      required: ['tldr', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_update',
    title: 'Update Memory',
    description: 'Update a memory in the project resolved from the authenticated caller session. Provide tldr and/or content; expectedUpdatedAt enables optimistic concurrency protection.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        tldr: { type: 'string', minLength: 1 },
        content: { type: 'string' },
        expectedUpdatedAt: { type: 'number' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_delete',
    title: 'Delete Memory',
    description: 'Delete a memory in the project resolved from the authenticated caller session and reroute valid project graph edges around it.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1 } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_search',
    title: 'Search Memories',
    description: 'Search tldr and content of project memories resolved from the authenticated caller session. Literal search is default; regex=true enables regular expressions. Optional graphDepth expands each matching root. Start narrow with the most specific multi-term query, then widen: drop terms, then try synonyms and alternate spellings, until your terminology is exhausted; only then conclude nothing is stored.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        regex: { type: 'boolean' },
        graphDepth: { type: 'integer', minimum: 0, maximum: 100 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_graph',
    title: 'Traverse Memory Graph',
    description: 'Traverse the project memory graph resolved from the authenticated caller session with optional graphDepth, per-path breadcrumbs, and cycle-safe loop/reference markers.',
    inputSchema: {
      type: 'object',
      properties: {
        rootId: { type: 'string', minLength: 1 },
        graphDepth: { type: 'integer', minimum: 0, maximum: 100 },
      },
      required: ['rootId'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_export',
    title: 'Export Memories',
    description: 'Export project memories resolved from the authenticated caller session as pure Markdown or lossless JSON. Optional rootId and graphDepth select a cycle-safe breadcrumbed graph; attachment metadata is included but bytes and storage paths are never exported.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['markdown', 'json'] },
        rootId: { type: 'string', minLength: 1 },
        graphDepth: { type: 'integer', minimum: 0, maximum: 100 },
      },
      required: ['format'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_link',
    title: 'Link Memories',
    description: 'Create a directed graph edge between two memories in the project resolved from the authenticated caller session.',
    inputSchema: {
      type: 'object',
      properties: {
        fromId: { type: 'string', minLength: 1 },
        toId: { type: 'string', minLength: 1 },
      },
      required: ['fromId', 'toId'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_unlink',
    title: 'Unlink Memories',
    description: 'Remove a directed graph edge between two memories in the project resolved from the authenticated caller session.',
    inputSchema: {
      type: 'object',
      properties: {
        fromId: { type: 'string', minLength: 1 },
        toId: { type: 'string', minLength: 1 },
      },
      required: ['fromId', 'toId'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_attachment_add',
    title: 'Add Memory Attachment',
    description: 'Attach an existing absolute source file to a project memory resolved from the authenticated caller session. Helm reads the file, stores metadata and bytes safely, and returns metadata only; the source file remains caller-owned.',
    inputSchema: {
      type: 'object',
      properties: {
        memoryId: { type: 'string', minLength: 1 },
        filePath: { type: 'string', minLength: 1, description: 'Absolute path to a regular source file.' },
        filename: { type: 'string', minLength: 1 },
        contentType: { type: 'string', minLength: 1 },
      },
      required: ['memoryId', 'filePath', 'filename'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_attachment_list',
    title: 'List Memory Attachments',
    description: 'List metadata for attachments on a project memory resolved from the authenticated caller session. Attachment content is never searchable.',
    inputSchema: {
      type: 'object',
      properties: { memoryId: { type: 'string', minLength: 1 } },
      required: ['memoryId'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_attachment_get',
    title: 'Get Memory Attachment',
    description: 'Copy a project memory attachment resolved from the authenticated caller session to a safe temporary file and return metadata plus tempPath. Bytes are never inlined; delete the temp file after use.',
    inputSchema: {
      type: 'object',
      properties: {
        memoryId: { type: 'string', minLength: 1 },
        attachmentId: { type: 'string', minLength: 1 },
      },
      required: ['memoryId', 'attachmentId'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_attachment_delete',
    title: 'Delete Memory Attachment',
    description: 'Delete an attachment from a project memory resolved from the authenticated caller session.',
    inputSchema: {
      type: 'object',
      properties: {
        memoryId: { type: 'string', minLength: 1 },
        attachmentId: { type: 'string', minLength: 1 },
      },
      required: ['memoryId', 'attachmentId'],
      additionalProperties: false,
    },
  },
  {
    name: 'mess_post',
    title: 'Post Mess',
    description: 'Store a bounded coordination message in the authenticated local session\'s project. Omit to for a project broadcast; pass a same-project session label (or exact id) for a direct message. This is social coordination only and never touches a PTY.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 4000 },
        to: { type: 'string', minLength: 1, description: 'Optional target session label or exact id in the same project.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'mess_check',
    title: 'Check Mess',
    description: 'Read the authenticated local session\'s bounded unread project Mess delta in sequence order. An empty poll returns exactly {new:0}; history is cursor-neutral and peer proxy callers are rejected.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'mess_history',
    title: 'Read Mess History',
    description: 'Read the last N project Mess notes without advancing the authenticated session cursor, grouped under date labels (newest group first, chronological within a group). Omit sinceHours to read the whole retained window; coordination remains social convention only.',
    inputSchema: {
      type: 'object',
      properties: {
        sinceHours: { type: 'number', minimum: 0, description: 'Optional age limit. Omit for the full retained window.' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        groupBy: { type: 'string', enum: ['day', 'month'], description: 'Date grouping for the result. Defaults to day.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'mess_search',
    title: 'Search Mess',
    description: 'Find project Mess notes containing literal text, with optional surrounding context. The query is LITERAL and case-insensitive, never a regular expression, so "." and "*" match themselves. Searches the whole retained log, not just recent mail, and never advances the caller cursor.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 200, description: 'Literal text to find. Not a pattern.' },
        before: { type: 'integer', minimum: 0, maximum: 20, description: 'Notes to include before each match.' },
        after: { type: 'integer', minimum: 0, maximum: 20, description: 'Notes to include after each match.' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        groupBy: { type: 'string', enum: ['day', 'month'] },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'peer_list',
    title: 'List Fleet Peers',
    description:
      'List the remote Helm peers this instance can reach, with each peer\'s id, alias, direction, and current online status. Start here for any cross-machine work: call peer_list to find a peer, then peer_tools(peer) to see what it will let you run, then peer_call(peer, tool, args) to invoke one of its tools. Returns an empty list — and peer_* tools report "Fleet is not enabled" — when fleet is turned off.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'peer_tools',
    title: 'List A Peer\'s Available Tools',
    description:
      'List the tools a specific remote peer will actually permit you to invoke (the peer\'s allow-list intersected with the tool catalogue). Call peer_list first to get a valid peer id/alias. The returned names + input schemas are that peer\'s NATIVE tool vocabulary — pass one verbatim to peer_call. An unknown or offline peer returns a clear error.',
    inputSchema: {
      type: 'object',
      properties: {
        peer: { type: 'string', description: 'The peer id (or alias) from peer_list.' },
      },
      required: ['peer'],
      additionalProperties: false,
    },
  },
  {
    name: 'peer_call',
    title: 'Invoke A Tool On A Peer',
    description:
      'Invoke ONE tool on a remote peer. `tool` and `args` are the peer\'s NATIVE tool name and argument object — exactly as returned by peer_tools(peer) — forwarded verbatim; do NOT namespace or rewrite them. Always call peer_list then peer_tools(peer) first to discover valid tools and their schemas. The remote enforces its own allow-list; an offline/unknown peer, a disallowed tool, or a timeout returns a clear error.',
    inputSchema: {
      type: 'object',
      properties: {
        peer: { type: 'string', description: 'The peer id (or alias) from peer_list.' },
        tool: { type: 'string', description: 'The peer\'s native tool name from peer_tools(peer).' },
        args: { type: 'object', description: 'The tool\'s argument object, forwarded to the peer verbatim.' },
      },
      required: ['peer', 'tool', 'args'],
      additionalProperties: false,
    },
  },
  {
    name: 'mobile_pair_start',
    title: 'Arm Phone Pairing',
    description:
      'Arm BLE pairing so the next phone offering a link becomes the pairing candidate. This also powers the radio on — Helm only scans when a phone is paired or pairing is armed. Then poll mobile_pair_status until it reports "awaiting-sas", compare the SAS digits with the phone\'s screen, and call mobile_pair_confirm. A newly paired phone is granted NOTHING: finish with mobile_device_allow or every call it makes will be denied. Local only — phones and fleet peers can never invoke this.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'mobile_pair_status',
    title: 'Read Phone Pairing Status',
    description:
      'The current pairing state: status (idle / scanning / awaiting-sas / paired / failed), the candidate device name, a failure reason, and — once a candidate is found — the SAS digits. Compare those digits against the ones shown on the phone BEFORE confirming; a mismatch is the only thing that distinguishes a real phone from a man in the middle. The SAS is a derived value, never key material.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'mobile_pair_confirm',
    title: 'Confirm Or Reject The Pairing SAS',
    description:
      'Accept or reject the pairing candidate after comparing SAS digits. Pass accepted=true only when mobile_pair_status digits match the phone exactly; pass accepted=false on any mismatch rather than leaving it to time out. Returns the resulting pairing state. On success the phone is registered but has an EMPTY allow-list — call mobile_device_allow next.',
    inputSchema: {
      type: 'object',
      properties: {
        accepted: { type: 'boolean', description: 'true only if the SAS digits match the phone exactly.' },
      },
      required: ['accepted'],
      additionalProperties: false,
    },
  },
  {
    name: 'mobile_pair_cancel',
    title: 'Cancel Phone Pairing',
    description:
      'Abandon an armed scan or a pending SAS confirmation and return to idle. Use this to clear a pairing that is stuck in "scanning" because no phone ever appeared.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Optional reason recorded in the resulting state.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'mobile_device_list',
    title: 'List Paired Phones',
    description:
      'List every paired phone with its record id, machineId, name, current allow-list, enabled flag, and whether it holds a live BLE link right now. Use the record id with mobile_device_allow. An empty allow-list means that phone is currently denied every call — which is the default immediately after pairing.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'mobile_device_allow',
    title: 'Set A Phone\'s Allow-List',
    description:
      'REPLACE (not merge) the tools a paired phone may invoke. Patterns are globs matched against tool names, e.g. ["session_list", "session_read_terminal", "session_send_text"] or ["session_*"]. Pass an empty array to revoke everything. A phone starts with an empty list and is denied every call until this is set, so this is the step that actually makes a paired phone useful. Host-lifecycle and pairing tools stay blocked even with a "*" grant.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'The record id from mobile_device_list.' },
        allow: {
          type: 'array',
          items: { type: 'string' },
          description: 'The complete intended grant; replaces whatever was there.',
        },
      },
      required: ['deviceId', 'allow'],
      additionalProperties: false,
    },
  },
];

