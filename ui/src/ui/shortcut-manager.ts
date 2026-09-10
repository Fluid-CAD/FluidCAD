import { isEditableTarget } from '../keyboard-bridge';

/**
 * Keyboard shortcuts for one scope of the UI.
 *
 * Two binding forms share a manager:
 *
 * - **Chords** — bare letter sequences (`c`, `ll`, `cp`) typed one key at a
 *   time. A chord that is also the prefix of a longer one (`c` vs `ca`)
 *   waits `timeout` ms for the next letter before firing.
 * - **Combos** — a key with modifiers (`mod+z`, `mod+shift+z`, `ctrl+y`).
 *   `mod` is Ctrl or ⌘, whichever the platform uses. Combos fire at once and
 *   never take part in chord matching.
 *
 * Every binding may carry a `when` guard: while it returns false the binding
 * does not exist as far as matching is concerned — the key is not consumed,
 * so a browser default or the host bridge still sees it, and a chord prefix
 * it would have opened does not hold the shorter chord back.
 *
 * All bindings that can be pressed at the same time MUST live in the same
 * manager: two managers listening on the same window match independently, so
 * a letter that is a plain chord in one and a chord prefix in the other fires
 * twice. Registering the same binding twice throws for that reason.
 */

export type ShortcutOptions = {
  /** The binding exists only while this returns true. */
  when?: () => boolean;
};

type Binding = {
  action: () => void;
  when: (() => boolean) | undefined;
};

type TrieNode = {
  children: Map<string, TrieNode>;
  binding: Binding | null;
};

type Combo = Binding & {
  keys: string;
  key: string;
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
};

const MODIFIER_TOKENS = new Set(['mod', 'ctrl', 'meta', 'shift', 'alt']);

function createNode(): TrieNode {
  return { children: new Map(), binding: null };
}

function isChord(keys: string): boolean {
  return /^[a-z]+$/.test(keys);
}

function parseCombo(keys: string, binding: Binding): Combo {
  const tokens = keys.split('+');
  const key = tokens.pop()!;
  if (key.length === 0 || tokens.length === 0 || tokens.some(t => !MODIFIER_TOKENS.has(t))) {
    throw new Error(`Shortcut "${keys}" is neither a letter chord nor a modifier combo`);
  }
  const has = (t: string) => tokens.includes(t);
  return {
    ...binding,
    keys,
    key,
    mod: has('mod'),
    ctrl: has('ctrl'),
    meta: has('meta'),
    shift: has('shift'),
    alt: has('alt'),
  };
}

function isActive(binding: Binding | null): binding is Binding {
  return binding !== null && (binding.when === undefined || binding.when());
}

/** Whether any binding under `node` (itself excluded) is active. */
function hasActiveDescendant(node: TrieNode): boolean {
  for (const child of node.children.values()) {
    if (isActive(child.binding) || hasActiveDescendant(child)) {
      return true;
    }
  }
  return false;
}

export const IS_MAC_PLATFORM = typeof navigator !== 'undefined'
  && /Mac|iPhone|iPad/.test(navigator.userAgent);

/**
 * A binding as shown to the user: chords verbatim (`ll`), combos with the
 * platform's modifier names (`Ctrl+Shift+Z`, `⌘⇧Z`).
 */
export function formatShortcut(keys: string, mac: boolean = IS_MAC_PLATFORM): string {
  if (isChord(keys)) {
    return keys;
  }
  const tokens = keys.split('+');
  const key = tokens.pop()!;
  const keyLabel = key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1);
  if (mac) {
    const glyphs: Record<string, string> = { mod: '⌘', meta: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' };
    return tokens.map(t => glyphs[t]).join('') + keyLabel;
  }
  const names: Record<string, string> = { mod: 'Ctrl', meta: 'Meta', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' };
  return [...tokens.map(t => names[t]), keyLabel].join('+');
}

export class ShortcutManager {
  private root: TrieNode = createNode();
  private combos: Combo[] = [];
  private buffer = '';
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private pendingAction: (() => void) | null = null;
  private enabled = false;
  private readonly timeout: number;
  private readonly boundHandler: (e: KeyboardEvent) => void;

  /**
   * While this returns true, letters are left alone rather than matched as
   * chords — the sketcher's coordinate pill takes the next printable key
   * to open itself. `isEditableTarget` only covers an *already* focused
   * field, and this manager's listener is registered before any tool's, so
   * standing down has to be explicit rather than a propagation trick.
   * Combos are unaffected: a modifier key is never a pill keystroke.
   */
  suspendWhile: (() => boolean) | null = null;

  constructor(options?: { timeout?: number }) {
    this.timeout = options?.timeout ?? 300;
    this.boundHandler = this.handleKeyDown.bind(this);
  }

  /**
   * Bind `keys` — a letter chord or a `mod+shift+z`-style combo — to
   * `action`. Throws when the binding is already taken: a silent overwrite
   * would hide exactly the collision this class exists to prevent.
   */
  register(keys: string, action: () => void, options?: ShortcutOptions): void {
    const binding: Binding = { action, when: options?.when };
    if (isChord(keys)) {
      let node = this.root;
      for (const ch of keys) {
        let child = node.children.get(ch);
        if (!child) {
          child = createNode();
          node.children.set(ch, child);
        }
        node = child;
      }
      if (node.binding) {
        throw new Error(`Shortcut "${keys}" is already registered`);
      }
      node.binding = binding;
      return;
    }
    const combo = parseCombo(keys.toLowerCase(), binding);
    if (this.combos.some(c => c.keys === combo.keys)) {
      throw new Error(`Shortcut "${keys}" is already registered`);
    }
    this.combos.push(combo);
  }

  /** Every registered binding string — for tooltips and tests. */
  bindings(): string[] {
    const out: string[] = [];
    const walk = (node: TrieNode, prefix: string) => {
      if (node.binding) {
        out.push(prefix);
      }
      for (const [ch, child] of node.children) {
        walk(child, prefix + ch);
      }
    };
    walk(this.root, '');
    for (const combo of this.combos) {
      out.push(combo.keys);
    }
    return out;
  }

  enable(): void {
    if (this.enabled) {
      return;
    }
    this.enabled = true;
    this.resetState();
    window.addEventListener('keydown', this.boundHandler);
  }

  disable(): void {
    if (!this.enabled) {
      return;
    }
    this.enabled = false;
    if (this.pendingAction) {
      const action = this.pendingAction;
      this.resetState();
      action();
    } else {
      this.resetState();
    }
    window.removeEventListener('keydown', this.boundHandler);
  }

  destroy(): void {
    this.disable();
    this.root = createNode();
    this.combos = [];
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) {
      // A modifier ends any chord in flight before the combo is looked up.
      this.firePendingAndReset();
      this.handleCombo(e);
      return;
    }

    if (e.repeat) {
      return;
    }

    if (isEditableTarget(e.target)) {
      return;
    }

    const key = e.key.toLowerCase();

    if (e.shiftKey && this.handleCombo(e)) {
      return;
    }

    if (this.suspendWhile?.()) {
      this.resetState();
      return;
    }

    if (key === 'escape') {
      this.resetState();
      return;
    }

    if (key.length !== 1 || key < 'a' || key > 'z') {
      this.firePendingAndReset();
      return;
    }

    this.clearTimer();

    const candidate = this.buffer + key;
    const { exactMatch, hasLongerPrefix } = this.lookupTrie(candidate);

    if (exactMatch && !hasLongerPrefix) {
      e.preventDefault();
      const action = exactMatch;
      this.resetState();
      action();
    } else if (exactMatch && hasLongerPrefix) {
      e.preventDefault();
      this.buffer = candidate;
      this.pendingAction = exactMatch;
      this.startTimer();
    } else if (hasLongerPrefix) {
      e.preventDefault();
      this.buffer = candidate;
      this.startTimer();
    } else {
      if (this.pendingAction) {
        e.preventDefault();
        const action = this.pendingAction;
        this.resetState();
        action();
      } else {
        this.resetState();
      }
    }
  }

  /**
   * Combos fire on repeat too — holding Ctrl+Z to walk back through the
   * history is how every editor behaves. A focused field keeps its own
   * Ctrl+Z (the code editor has a native undo stack of its own).
   */
  private handleCombo(e: KeyboardEvent): boolean {
    if (isEditableTarget(e.target)) {
      return false;
    }
    const combo = this.matchCombo(e);
    if (!combo) {
      return false;
    }
    e.preventDefault();
    combo.action();
    return true;
  }

  private matchCombo(e: KeyboardEvent): Combo | null {
    const key = e.key.toLowerCase();
    for (const combo of this.combos) {
      if (combo.key !== key || !isActive(combo)) {
        continue;
      }
      // `mod` takes either primary modifier, as the editor-pane toggle
      // always has; a literal ctrl/meta wants exactly that one.
      const modOk = combo.mod
        ? (e.ctrlKey || e.metaKey)
        : (combo.ctrl === e.ctrlKey && combo.meta === e.metaKey);
      if (modOk && combo.shift === e.shiftKey && combo.alt === e.altKey) {
        return combo;
      }
    }
    return null;
  }

  private lookupTrie(sequence: string): { exactMatch: (() => void) | null; hasLongerPrefix: boolean } {
    let node = this.root;
    for (const ch of sequence) {
      const child = node.children.get(ch);
      if (!child) {
        return { exactMatch: null, hasLongerPrefix: false };
      }
      node = child;
    }
    return {
      exactMatch: isActive(node.binding) ? node.binding.action : null,
      hasLongerPrefix: hasActiveDescendant(node),
    };
  }

  private firePendingAndReset(): void {
    if (this.pendingAction) {
      const action = this.pendingAction;
      this.resetState();
      action();
    } else {
      this.resetState();
    }
  }

  private resetState(): void {
    this.clearTimer();
    this.buffer = '';
    this.pendingAction = null;
  }

  private clearTimer(): void {
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  private startTimer(): void {
    this.clearTimer();
    this.timerId = setTimeout(() => {
      this.timerId = null;
      this.firePendingAndReset();
    }, this.timeout);
  }
}
