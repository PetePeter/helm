import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/headless';
import { installMouseTrackingGuard, splitMouseModes } from '../../renderer/terminal/mouse-tracking-guard.js';

/** Write and wait until parsed — plus one flush, since the guard re-writes kept modes as a follow-up write. */
async function write(term: Terminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => term.write(data, resolve));
  await new Promise<void>((resolve) => term.write('', resolve));
}

function makeTerminal(guard: boolean): Terminal {
  const term = new Terminal({ allowProposedApi: true });
  if (guard) installMouseTrackingGuard(term);
  return term;
}

describe('installMouseTrackingGuard', () => {
  it('swallows a plain mouse-tracking enable so drag selects text', async () => {
    const term = makeTerminal(true);
    await write(term, '\x1b[?1000h');
    expect(term.modes.mouseTrackingMode).toBe('none');
  });

  it('still applies non-mouse modes in a mixed DECSET', async () => {
    const term = makeTerminal(true);
    // Headless exposes no cursor-visibility mode; bracketed paste (?2004) stands in as a plain non-mouse mode.
    await write(term, '\x1b[?1002;1006;2004h');
    expect(term.modes.bracketedPasteMode).toBe(true);
    expect(term.modes.mouseTrackingMode).toBe('none');
  });

  it('applies non-mouse modes in a mixed DECRST', async () => {
    const term = makeTerminal(true);
    await write(term, '\x1b[?2004h');
    await write(term, '\x1b[?1003;2004l');
    expect(term.modes.bracketedPasteMode).toBe(false);
  });

  it('swallows a mouse mode split across writes', async () => {
    const term = makeTerminal(true);
    await write(term, '\x1b[?10');
    await write(term, '02h');
    expect(term.modes.mouseTrackingMode).toBe('none');
  });

  it('leaves mouse tracking working when the guard is not installed', async () => {
    const term = makeTerminal(false);
    await write(term, '\x1b[?1000h');
    expect(term.modes.mouseTrackingMode).not.toBe('none');
  });
});

describe('splitMouseModes', () => {
  it('separates mouse modes from the rest', () => {
    expect(splitMouseModes([1002, 1006, 25])).toEqual({ hasMouse: true, kept: [25] });
    expect(splitMouseModes([25, 1049])).toEqual({ hasMouse: false, kept: [25, 1049] });
  });
});
