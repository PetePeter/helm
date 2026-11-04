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
 * saturated hues in wheel order (so the picker reads as a spectrum), then two
 * neutrals. Each reads against the dark sidebar, tinted and as a border.
 */
export const RUNTIME_GROUP_COLORS = [
  '#ff1744', '#ff3d00', '#ff6d00', '#ff9100', '#ffc400', '#ffea00', '#aeea00', '#64dd17', '#00c853', '#00bfa5',
  '#00e5ff', '#00b0ff', '#2979ff', '#304ffe', '#651fff', '#aa00ff', '#d500f9', '#f50057', '#8d6e63', '#ffffff',
] as const;

/** The retired pastel palette, mapped to its nearest saturated successor so saved groups keep their hue. */
const LEGACY_GROUP_COLORS: Readonly<Record<string, string>> = {
  '#a07aff': '#aa00ff', '#4488ff': '#2979ff', '#2ec4b6': '#00bfa5', '#44cc44': '#00c853',
  '#e6c229': '#ffc400', '#ff9f43': '#ff9100', '#ff6b6b': '#ff1744', '#ff6bcb': '#f50057',
};

/** A stored colour as a current palette entry, or undefined when it is neither current nor legacy. */
export function normalizeRuntimeGroupColor(value: unknown): string | undefined {
  if (isRuntimeGroupColor(value)) return value;
  return typeof value === 'string' ? LEGACY_GROUP_COLORS[value] : undefined;
}

export function isRuntimeGroupColor(value: unknown): value is string {
  return typeof value === 'string' && (RUNTIME_GROUP_COLORS as readonly string[]).includes(value);
}
