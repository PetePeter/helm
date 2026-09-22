/**
 * The data contract for Team View. This deliberately owns no session or PTY
 * state: it projects the existing renderer state so Team View and Session List
 * cannot diverge into separate sources of truth.
 */

import type { ProjectSummary, Session } from '../state.js';

export type TeamViewSessionState = 'implementing' | 'waiting' | 'planning' | 'completed' | 'idle';
export type TeamViewWaitingReason = 'human' | 'agent' | 'unknown';

/** A desk-facing LLM notification; carried verbatim, owned by the llmNotifications store. */
export interface TeamViewNotification {
  id: string;
  title: string;
  content: string;
  createdAt: number;
}

export interface TeamViewDesk {
  sessionId: string;
  name: string;
  cliType: string;
  title?: string;
  state: TeamViewSessionState;
  /** PTY-output activity level (active/inactive/idle) — drives the shared dot palette. */
  activityLevel: string;
  /** Why a waiting desk is waiting, when there is evidence for it. */
  waitingReason?: TeamViewWaitingReason;
  /** A passive, already-clipped PTY tail. Team View never writes to it. */
  terminalTail: string[];
  hidden: boolean;
  focusIndex: number;
  focusLabel: string;
  /** Projected from the same live session sources as Session List. */
  locked: boolean;
  artifactCount: number;
  /** Live notifications for this session; the projection owns no copy of them. */
  notifications: TeamViewNotification[];
}

export interface TeamViewDepartment {
  id: string;
  name: string;
  collapsed: boolean;
  desks: TeamViewDesk[];
  visibleDeskCount: number;
  /** How many member desks are hidden from Team View (kept in `desks`). */
  hiddenDeskCount: number;
}

export interface TeamViewProjection {
  departments: TeamViewDepartment[];
  deskCount: number;
  visibleDeskCount: number;
}

export interface TeamViewProjectionInput {
  sessions: readonly Session[];
  projects: readonly ProjectSummary[];
  /** Renderer display state is authoritative over the persisted session field. */
  stateForSession?: (session: Session) => string | undefined;
  /** PTY-output timing source (the same one Session List dots read); default idle. */
  activityLevelForSession?: (sessionId: string) => string | undefined;
  /** Optional future source for a known agent wait; unknown is retained safely. */
  waitingReasonForSession?: (session: Session) => TeamViewWaitingReason | undefined;
  /** Existing renderer PTY-buffer boundary; this module never reads xterm itself. */
  terminalTailForSession?: (sessionId: string) => readonly string[];
  tailLineLimit?: number;
  collapsedDepartmentIds?: ReadonlySet<string>;
  hiddenSessionIds?: ReadonlySet<string>;
  artifactCountForSession?: (sessionId: string) => number | undefined;
  /** Live notification feed (the llmNotifications store); default none. */
  notificationsForSession?: (sessionId: string) => readonly TeamViewNotification[];
  /** The shared Session List slot map; undefined means no assigned Ctrl+number shortcut. */
  focusSlotForSession?: (sessionId: string) => number | undefined;
}

interface DepartmentSeed {
  id: string;
  name: string;
}

const SESSION_STATES = new Set<TeamViewSessionState>([
  'implementing', 'waiting', 'planning', 'completed', 'idle',
]);
const WAITING_REASONS = new Set<TeamViewWaitingReason>(['human', 'agent', 'unknown']);

function pathTail(path?: string): string {
  const trimmed = path?.replace(/[\\/]+$/, '') ?? '';
  return trimmed.split(/[\\/]/).pop() || 'Unassigned';
}

function resolveDepartment(session: Session, projects: readonly ProjectSummary[]): DepartmentSeed {
  const byId = session.projectId
    ? projects.find(project => project.id === session.projectId)
    : undefined;
  if (byId) return { id: `project:${byId.id}`, name: byId.name };

  const sessionPath = session.projectPath ?? session.workingDir;
  const byPath = sessionPath
    ? projects.find(project => project.canonicalPath === sessionPath || project.alternatePaths.includes(sessionPath))
    : undefined;
  if (byPath) return { id: `project:${byPath.id}`, name: byPath.name };

  const fallbackPath = session.projectPath ?? session.workingDir ?? '';
  return { id: `path:${fallbackPath}`, name: pathTail(fallbackPath) };
}

function resolveState(session: Session, stateForSession?: TeamViewProjectionInput['stateForSession']): TeamViewSessionState {
  const state = stateForSession?.(session) ?? session.aiagentState ?? session.state ?? 'idle';
  return SESSION_STATES.has(state as TeamViewSessionState) ? state as TeamViewSessionState : 'idle';
}

function resolveWaitingReason(
  session: Session,
  state: TeamViewSessionState,
  waitingReasonForSession?: TeamViewProjectionInput['waitingReasonForSession'],
): TeamViewWaitingReason | undefined {
  if (state !== 'waiting') return undefined;
  // AIAGENT-QUESTION is the only currently authoritative wait-reason signal.
  if (session.questionPending) return 'human';
  const supplied = waitingReasonForSession?.(session);
  if (WAITING_REASONS.has(supplied as TeamViewWaitingReason)) return supplied;
  // A phase describes what the agent was doing, not why it is now waiting.
  // Do not turn completed/idle (or any phase) into a false agent-wait cue.
  return 'unknown';
}

function compareDepartments(left: TeamViewDepartment, right: TeamViewDepartment): number {
  return left.id.localeCompare(right.id);
}

/**
 * Department display order: by the lowest Session List slot any member desk
 * carries, so `Ctrl+number` reads top-down across the whole view. Departments
 * with no slotted desks follow in the historical id order.
 */
function compareDepartmentsBySlot(
  slots?: (sessionId: string) => number | undefined,
): (left: TeamViewDepartment, right: TeamViewDepartment) => number {
  const lowestSlot = (department: TeamViewDepartment): number | undefined => {
    let lowest: number | undefined;
    for (const desk of department.desks) {
      const slot = slots?.(desk.sessionId);
      if (slot !== undefined && (lowest === undefined || slot < lowest)) lowest = slot;
    }
    return lowest;
  };
  return (left, right) => {
    const leftSlot = lowestSlot(left);
    const rightSlot = lowestSlot(right);
    if (leftSlot === undefined && rightSlot === undefined) return compareDepartments(left, right);
    if (leftSlot === undefined) return 1;
    if (rightSlot === undefined) return -1;
    return leftSlot - rightSlot || compareDepartments(left, right);
  };
}

function compareSessions(left: Session, right: Session): number {
  const leftCreated = left.createdAt ?? Number.MAX_SAFE_INTEGER;
  const rightCreated = right.createdAt ?? Number.MAX_SAFE_INTEGER;
  return leftCreated - rightCreated || left.id.localeCompare(right.id);
}

/**
 * Desk display order within a department: desks carrying a shared Session List
 * slot lead, ascending by slot, so the Ctrl+number order reads top-to-bottom;
 * slot-less desks follow in the historical createdAt/id order.
 */
function compareSessionsBySlot(
  slots?: (sessionId: string) => number | undefined,
): (left: Session, right: Session) => number {
  return (left, right) => {
    const leftSlot = slots?.(left.id);
    const rightSlot = slots?.(right.id);
    if (leftSlot === undefined && rightSlot === undefined) return compareSessions(left, right);
    if (leftSlot === undefined) return 1;
    if (rightSlot === undefined) return -1;
    return leftSlot - rightSlot || compareSessions(left, right);
  };
}

function isHidden(session: Session, hiddenSessionIds: ReadonlySet<string>): boolean {
  return hiddenSessionIds.has(session.id)
    || (session.cliSessionName !== undefined && hiddenSessionIds.has(session.cliSessionName));
}

/** Build one deterministic, presentation-only Team View model from live sessions. */
export function buildTeamViewProjection(input: TeamViewProjectionInput): TeamViewProjection {
  const collapsed = input.collapsedDepartmentIds ?? new Set<string>();
  const hidden = input.hiddenSessionIds ?? new Set<string>();
  const tailLimit = Math.max(0, input.tailLineLimit ?? 4);
  const buckets = new Map<string, { seed: DepartmentSeed; sessions: Session[] }>();

  for (const session of input.sessions) {
    const seed = resolveDepartment(session, input.projects);
    const bucket = buckets.get(seed.id) ?? { seed, sessions: [] };
    bucket.sessions.push(session);
    buckets.set(seed.id, bucket);
  }

  const departments = Array.from(buckets.values())
    .map(({ seed, sessions }) => {
      const desks = [...sessions].sort(compareSessionsBySlot(input.focusSlotForSession)).map((session) => {
        const state = resolveState(session, input.stateForSession);
        const terminalTail = input.terminalTailForSession?.(session.id) ?? [];
        const waitingReason = resolveWaitingReason(session, state, input.waitingReasonForSession);
        const desk: TeamViewDesk = {
          sessionId: session.id,
          name: session.name,
          cliType: session.cliType,
          ...(session.title ? { title: session.title } : {}),
          state,
          activityLevel: input.activityLevelForSession?.(session.id) ?? 'idle',
          ...(waitingReason ? { waitingReason } : {}),
          terminalTail: terminalTail.slice(-tailLimit),
          hidden: isHidden(session, hidden),
          // Reassigned after departments are ordered for display.
          focusIndex: 0,
          focusLabel: '^1',
          locked: session.locked === true,
          artifactCount: input.artifactCountForSession?.(session.id) ?? 0,
          notifications: [...(input.notificationsForSession?.(session.id) ?? [])],
        };
        return desk;
      });
      return {
        id: seed.id,
        name: seed.name,
        collapsed: collapsed.has(seed.id),
        desks,
        visibleDeskCount: desks.filter(desk => !desk.hidden).length,
        hiddenDeskCount: desks.filter(desk => desk.hidden).length,
      };
    })
    .sort(compareDepartmentsBySlot(input.focusSlotForSession));

  // Focus labels follow the displayed department ordering, not insertion order.
  let displayedIndex = 0;
  const hasSharedSlots = input.focusSlotForSession !== undefined;
  for (const department of departments) {
    for (const desk of department.desks) {
      const slot = input.focusSlotForSession?.(desk.sessionId);
      // Standalone callers retain deterministic labels. The live pane supplies
      // the Session List map, where an absent slot must not advertise a key.
      desk.focusIndex = slot === undefined ? (hasSharedSlots ? -1 : displayedIndex) : (slot === 0 ? 9 : slot - 1);
      desk.focusLabel = slot === undefined ? (hasSharedSlots ? '' : `^${displayedIndex + 1}`) : `^${slot}`;
      displayedIndex++;
    }
  }

  const deskCount = displayedIndex;
  return {
    departments,
    deskCount,
    visibleDeskCount: departments.reduce((total, department) => total + department.visibleDeskCount, 0),
  };
}
