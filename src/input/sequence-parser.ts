export type SequenceAction =
  | { type: 'text'; value: string }
  | { type: 'key'; key: string }
  | { type: 'combo'; keys: string[] }
  | { type: 'modDown'; key: string }
  | { type: 'modUp'; key: string }
  | { type: 'wait'; ms: number }
  | { type: 'noSubmit' };

export function parseSequence(input: string): SequenceAction[] {
  const actions: SequenceAction[] = [];
  let i = 0;

  while (i < input.length) {
    if (input[i] === '{') {
      if (input[i + 1] === '{') {
        appendText(actions, '{');
        i += 2;
      } else {
        const closeIdx = input.indexOf('}', i + 1);
        if (closeIdx === -1) {
          appendText(actions, input.slice(i));
          break;
        }
        const token = input.slice(i + 1, closeIdx);
        const action = parseToken(token);
        if (action) actions.push(action);
        i = closeIdx + 1;
      }
    } else if (input[i] === '}') {
      if (input[i + 1] === '}') {
        appendText(actions, '}');
        i += 2;
      } else {
        appendText(actions, '}');
        i++;
      }
    } else {
      appendText(actions, input[i]);
      i++;
    }
  }

  return actions;
}

function appendText(actions: SequenceAction[], text: string): void {
  const last = actions[actions.length - 1];
  if (last && last.type === 'text') last.value += text;
  else actions.push({ type: 'text', value: text });
}

const KEY_ALIASES: Record<string, string> = {
  enter: 'Enter', send: 'Send', tab: 'Tab', esc: 'Esc', escape: 'Escape', space: 'Space', backspace: 'Backspace', delete: 'Delete',
  up: 'Up', down: 'Down', right: 'Right', left: 'Left', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowright: 'ArrowRight', arrowleft: 'ArrowLeft',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', insert: 'Insert', capslock: 'CapsLock', printscreen: 'PrintScreen',
};
for (let i = 1; i <= 12; i++) KEY_ALIASES[`f${i}`] = `F${i}`;

const MODIFIER_ALIASES: Record<string, string> = {
  ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', shift: 'Shift', win: 'Win', meta: 'Win', cmd: 'Win', command: 'Win', option: 'Alt',
};

function parseToken(token: string): SequenceAction | null {
  if (token === '') return null;

  if (/^(NoSend|NoEnter)$/i.test(token.trim())) return { type: 'noSubmit' };

  const waitMatch = token.match(/^Wait\s+(\d+)$/i);
  if (waitMatch) return { type: 'wait', ms: Math.min(parseInt(waitMatch[1], 10), 30000) };

  const downMatch = token.match(/^(\S+)\s+Down$/i);
  if (downMatch) return { type: 'modDown', key: canonicalizeModifier(downMatch[1]) };

  const upMatch = token.match(/^(\S+)\s+Up$/i);
  if (upMatch) return { type: 'modUp', key: canonicalizeModifier(upMatch[1]) };

  if (token.includes('+')) {
    const keys = token.split('+').map(k => canonicalizeComboPart(k.trim())).filter(k => k);
    if (keys.length === 0) return null;
    return { type: 'combo', keys };
  }

  return { type: 'key', key: canonicalizeKey(token) };
}

function canonicalizeModifier(token: string): string { return MODIFIER_ALIASES[token.toLowerCase()] ?? token; }
function canonicalizeComboPart(token: string): string {
  if (token === '') return '';
  const modifier = MODIFIER_ALIASES[token.toLowerCase()];
  if (modifier) return modifier;
  const key = KEY_ALIASES[token.toLowerCase()];
  if (key) return key;
  if (token.length === 1) return token.toUpperCase();
  return token;
}
function canonicalizeKey(token: string): string { return KEY_ALIASES[token.toLowerCase()] ?? token; }

/**
 * True when `{token}` names something the parser acts on — a key, combo,
 * modifier hold/release, wait or no-submit. parseToken itself is lenient (any
 * word becomes a key); this is the strict check editors use to flag typos.
 */
export function isKnownSequenceToken(token: string): boolean {
  const action = parseToken(token);
  if (!action) return false;
  const known = (part: string) => part.length === 1 || part in KEY_LOOKUP || part in MODIFIER_LOOKUP;
  switch (action.type) {
    case 'key': return known(action.key);
    case 'combo': return action.keys.every(known);
    case 'modDown':
    case 'modUp': return action.key in MODIFIER_LOOKUP;
    default: return true;
  }
}
const KEY_LOOKUP: Record<string, true> = Object.fromEntries(Object.values(KEY_ALIASES).map(key => [key, true]));
const MODIFIER_LOOKUP: Record<string, true> = Object.fromEntries(Object.values(MODIFIER_ALIASES).map(key => [key, true]));

export function formatSequencePreview(actions: SequenceAction[]): string { return actions.map(formatAction).join(' → '); }
function formatAction(action: SequenceAction): string {
  switch (action.type) {
    case 'text': return `Type "${action.value}"`;
    case 'key': return action.key;
    case 'combo': return action.keys.join('+');
    case 'modDown': return `${action.key} ↓`;
    case 'modUp': return `${action.key} ↑`;
    case 'wait': return `Wait ${action.ms}ms`;
    case 'noSubmit': return 'No final submit';
  }
}
