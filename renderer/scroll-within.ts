/**
 * Bring `el` fully into view by scrolling ONLY `container`.
 *
 * `scrollIntoView` also scrolls every ancestor — including `overflow: hidden`
 * ones — so a row near the top of the session list dragged the whole pane up
 * over the Operator section instead of scrolling the list itself.
 */
export function scrollWithin(container: HTMLElement, el: HTMLElement): void {
  const box = container.getBoundingClientRect();
  const row = el.getBoundingClientRect();
  if (row.top < box.top) container.scrollTop -= box.top - row.top;
  else if (row.bottom > box.bottom) container.scrollTop += row.bottom - box.bottom;
}
