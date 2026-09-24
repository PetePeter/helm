/**
 * Mission-bar height bounds. The bar must never eat the terminal: at least one
 * line so it stays visible, at most 240px or 40% of the pane, whichever is
 * smaller. Main clamps again (src/session/mission.ts) because the renderer is
 * not the only thing that could write the value.
 */

export const MISSION_BAR_MIN_PX = 28;
export const MISSION_BAR_MAX_PX = 240;
export const MISSION_BAR_DEFAULT_PX = 56;
const MAX_PANE_FRACTION = 0.4;

/** Clamp a proposed height. An unmeasured pane (0) only applies the fixed cap. */
export function clampMissionBarHeight(px: number, paneHeight: number): number {
  const paneCap = paneHeight > 0 ? Math.floor(paneHeight * MAX_PANE_FRACTION) : MISSION_BAR_MAX_PX;
  const max = Math.max(MISSION_BAR_MIN_PX, Math.min(MISSION_BAR_MAX_PX, paneCap));
  return Math.round(Math.min(max, Math.max(MISSION_BAR_MIN_PX, px)));
}
