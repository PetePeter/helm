/**
 * Mouse-tracking guard — stops CLIs from capturing the mouse.
 *
 * TUI CLIs (e.g. Copilot CLI) enable xterm mouse tracking via DECSET, which
 * routes plain click-drag to the app and forces users to Shift+drag to copy.
 * Unless a CLI type opts in with `mouseTracking: true`, we swallow those modes
 * so plain drag selects text. Lives outside terminal-view.ts so it can be
 * exercised against @xterm/headless without a DOM.
 */

/** X10/VT200/highlight/button/any-event tracking plus UTF-8/SGR/URXVT/SGR-pixel encodings. */
const MOUSE_MODES = new Set([1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016]);

/** Minimal slice of an xterm Terminal (browser or headless) the guard needs. */
export interface GuardableTerminal {
  parser: {
    registerCsiHandler(
      id: { prefix?: string; final: string },
      callback: (params: (number | number[])[]) => boolean | Promise<boolean>,
    ): { dispose(): void };
  };
  write(data: string): void;
}

/** Partition DEC private mode params into "contains mouse" + the non-mouse remainder. */
export function splitMouseModes(params: (number | number[])[]): { hasMouse: boolean; kept: number[] } {
  const flat = params.map((p) => (Array.isArray(p) ? p[0] : p));
  const kept = flat.filter((p) => !MOUSE_MODES.has(p));
  return { hasMouse: kept.length !== flat.length, kept };
}

/**
 * Register DECSET/DECRST handlers that drop mouse modes. Mixed sequences
 * (e.g. `?1002;1006;25h`) are swallowed and the non-mouse remainder re-written;
 * that can't recurse because the remainder has no mouse modes.
 */
export function installMouseTrackingGuard(terminal: GuardableTerminal): void {
  for (const final of ['h', 'l']) {
    terminal.parser.registerCsiHandler({ prefix: '?', final }, (params) => {
      const { hasMouse, kept } = splitMouseModes(params);
      if (!hasMouse) return false;
      if (kept.length > 0) terminal.write(`\x1b[?${kept.join(';')}${final}`);
      return true;
    });
  }
}
