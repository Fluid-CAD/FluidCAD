import { isEditableTarget } from '../keyboard-bridge';

type TrieNode = {
  children: Map<string, TrieNode>;
  action: (() => void) | null;
};

function createNode(): TrieNode {
  return { children: new Map(), action: null };
}

export class ShortcutManager {
  private root: TrieNode = createNode();
  private buffer = '';
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private pendingAction: (() => void) | null = null;
  private enabled = false;
  private readonly timeout: number;
  private readonly boundHandler: (e: KeyboardEvent) => void;

  constructor(options?: { timeout?: number }) {
    this.timeout = options?.timeout ?? 300;
    this.boundHandler = this.handleKeyDown.bind(this);
  }

  register(keys: string, action: () => void): void {
    let node = this.root;
    for (const ch of keys) {
      let child = node.children.get(ch);
      if (!child) {
        child = createNode();
        node.children.set(ch, child);
      }
      node = child;
    }
    node.action = action;
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
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.repeat) {
      return;
    }

    if (e.ctrlKey || e.metaKey || e.altKey) {
      this.firePendingAndReset();
      return;
    }

    if (isEditableTarget(e.target)) {
      return;
    }

    const key = e.key.toLowerCase();

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
      exactMatch: node.action,
      hasLongerPrefix: node.children.size > 0,
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
