/**
 * Plan canvas viewport maths. The view is a fixed ZOOM (screen px per canvas
 * unit) plus a top-left position, so resizing the pane reveals more or less
 * canvas instead of stretching the plan to fit — and the saved view restores
 * at the same zoom whatever size the pane reopens at.
 */

export interface ViewBox { x: number; y: number; w: number; h: number }
export interface PaneSize { w: number; h: number }
export interface SavedPlanView { zoom: number; x: number; y: number }

/** Keep zoom and top-left across a pane resize; a sizeless (hidden) pane changes nothing. */
export function resizeViewBox(vb: ViewBox, from: PaneSize, to: PaneSize): ViewBox {
  if (!from.w || !from.h || !to.w || !to.h) return vb;
  return { x: vb.x, y: vb.y, w: vb.w * (to.w / from.w), h: vb.h * (to.h / from.h) };
}

/** First open: the whole content at one uniform zoom, anchored top-left. */
export function fitViewBox(content: { width: number; height: number }, pane: PaneSize): ViewBox {
  const zoom = Math.min(pane.w / content.width, pane.h / content.height);
  return { x: 0, y: 0, w: pane.w / zoom, h: pane.h / zoom };
}

export function savedFromViewBox(vb: ViewBox, pane: PaneSize): SavedPlanView {
  return { zoom: pane.w / vb.w, x: vb.x, y: vb.y };
}

export function viewBoxFromSaved(saved: SavedPlanView, pane: PaneSize): ViewBox {
  return { x: saved.x, y: saved.y, w: pane.w / saved.zoom, h: pane.h / saved.zoom };
}
