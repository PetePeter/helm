/**
 * Runtime session group — an ad-hoc grouping of sessions that cuts across
 * working directories.
 *
 * A session belongs to AT MOST ONE runtime group (exclusive membership). Groups
 * persist independently of their membership, so an empty group is a valid,
 * intentional state and is kept until explicitly closed.
 */
export interface RuntimeGroup {
  /** Unique group identifier (UUID). */
  id: string;
  /** User-facing display name. */
  name: string;
  /** Member session ids. Exclusive membership; array order = display order. */
  sessionIds: string[];
  /** Whether the group is collapsed in the sidebar. */
  collapsed: boolean;
  /** Epoch ms the group was created. */
  createdAt: number;
  /** Epoch ms of the last mutation to this group. */
  updatedAt: number;
  /** User-picked colour from RUNTIME_GROUP_COLORS. Absent = the default (first). */
  color?: string;
}

/**
 * The colours a custom group may take. A fixed palette rather than any hex:
 * each one is checked to read against the dark sidebar, tinted and as a border.
 */
export const RUNTIME_GROUP_COLORS = [
  '#a07aff', '#4488ff', '#2ec4b6', '#44cc44', '#e6c229', '#ff9f43', '#ff6b6b', '#ff6bcb',
] as const;

export function isRuntimeGroupColor(value: unknown): value is string {
  return typeof value === 'string' && (RUNTIME_GROUP_COLORS as readonly string[]).includes(value);
}
