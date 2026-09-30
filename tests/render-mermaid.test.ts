// @vitest-environment jsdom
/**
 * renderMermaidNodes — every diagram gets its own id, and renders never overlap.
 *
 * mermaid.run() names diagrams `mermaid-<Date.now()>`; two in the same
 * millisecond share an id, and mermaid's id-scoped styles (edges fill:none,
 * text colours) then apply to only one of them — the other draws filled
 * triangles for arrows and dark-on-dark text. The mermaid engine itself needs a
 * real layout engine (jsdom has none), so the render call is a stand-in that
 * returns an SVG carrying the id it was given, exactly as mermaid does.
 */
import { describe, it, expect } from 'vitest';
import { renderMermaidNodes, type MermaidRender } from '../renderer/artifacts/render-mermaid.js';

function diagrams(n: number): HTMLElement[] {
  return Array.from({ length: n }, (_, i) => {
    const pre = document.createElement('pre');
    pre.className = 'mermaid';
    pre.textContent = `graph LR\n  A${i} --> B${i}`;
    document.body.append(pre);
    return pre;
  });
}

const svgRender: MermaidRender = async (id) => ({ svg: `<svg id="${id}"><style>#${id} .edge{fill:none}</style></svg>` });

describe('renderMermaidNodes', () => {
  it('gives every diagram a distinct id, even across calls', async () => {
    const first = diagrams(2);
    const second = diagrams(1);
    await renderMermaidNodes(first, svgRender);
    await renderMermaidNodes(second, svgRender);
    const ids = [...first, ...second].map(n => n.querySelector('svg')?.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids.every(Boolean)).toBe(true);
  });

  it('runs overlapping calls one after another, never interleaved', async () => {
    const log: string[] = [];
    const slow: MermaidRender = async (id) => {
      log.push(`start ${id}`);
      await new Promise(r => setTimeout(r, 5));
      log.push(`end ${id}`);
      return { svg: `<svg id="${id}"></svg>` };
    };
    const [a, b] = diagrams(2);
    await Promise.all([renderMermaidNodes([a], slow), renderMermaidNodes([b], slow)]);
    expect(log[0].startsWith('start')).toBe(true);
    expect(log[1].startsWith('end')).toBe(true);
    expect(log[2].startsWith('start')).toBe(true);
  });

  it('renders a node once even when asked twice', async () => {
    let calls = 0;
    const counting: MermaidRender = async (id) => { calls++; return { svg: `<svg id="${id}"></svg>` }; };
    const [a] = diagrams(1);
    await Promise.all([renderMermaidNodes([a], counting), renderMermaidNodes([a], counting)]);
    expect(calls).toBe(1);
  });

  it('keeps the source and adds a failure note when a diagram does not parse', async () => {
    const [a] = diagrams(1);
    await renderMermaidNodes([a], async () => { throw new Error('Parse error'); });
    expect(a.textContent).toContain('graph LR');
    expect(a.querySelector('.mermaid-fail-note')).not.toBeNull();
    expect(a.classList.contains('mermaid-failed')).toBe(true);
  });
});
