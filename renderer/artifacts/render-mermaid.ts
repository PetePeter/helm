/**
 * Turn `<pre class="mermaid">` markers into diagrams, one at a time, each under
 * its own id.
 *
 * Why not mermaid.run(): it names diagrams `mermaid-<Date.now()>`, so two
 * rendered in the same millisecond share an id. Mermaid scopes each diagram's
 * styles by that id (edges `fill:none`, label colours), so the duplicate draws
 * arrows as filled triangles and text dark-on-dark. Mermaid also keeps global
 * render state, so two renders must never interleave — hence the queue.
 */

export type MermaidRender = (id: string, source: string) => Promise<{ svg: string }>;

let seq = 0;
let queue: Promise<void> = Promise.resolve();

export function renderMermaidNodes(nodes: HTMLElement[], render: MermaidRender): Promise<void> {
  const run = queue.then(() => renderEach(nodes, render));
  queue = run.catch(() => undefined);
  return run;
}

async function renderEach(nodes: HTMLElement[], render: MermaidRender): Promise<void> {
  for (const node of nodes) {
    // Claimed before rendering, so a second request for the same node skips it.
    if (node.hasAttribute('data-processed')) continue;
    node.setAttribute('data-processed', 'true');
    const source = node.textContent ?? '';
    try {
      const { svg } = await render(`helm-mermaid-${++seq}`, source);
      node.innerHTML = svg;
    } catch (err) {
      console.error('[mermaid] render failed', err);
      markFailed(node);
    }
  }
}

/** A diagram that did not render keeps its source and says so, rather than passing for code. */
function markFailed(node: HTMLElement): void {
  node.classList.add('mermaid-failed');
  const note = document.createElement('div');
  note.className = 'mermaid-fail-note';
  note.textContent = '⚠ Diagram could not be rendered — see source above';
  node.append(note);
}
