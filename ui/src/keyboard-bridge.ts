/**
 * Forwards unhandled modifier-bearing keyboard shortcuts from the FluidCAD UI
 * (running inside an iframe in a VSCode webview) up to the parent webview
 * document, where a small re-dispatcher hands them to VSCode's keybinding
 * service. Local UI handlers opt out by calling `e.preventDefault()`.
 *
 * Now that there is a code editor in the page, "unhandled" has to mean it:
 * Monaco owns <kbd>Ctrl+F</kbd>, <kbd>Ctrl+D</kbd>, <kbd>Ctrl+/</kbd> and a
 * long tail besides, and forwarding those would let the host steal them out of
 * the editor mid-keystroke.
 */

const FUNCTION_KEY = /^F([1-9]|1[0-9])$/;

/** Hook for FluidCAD-owned shortcuts that don't preventDefault. */
export function isOwnedShortcut(e: KeyboardEvent): boolean {
  return isInsideCodeEditor(e.target);
}

/**
 * Monaco is not an `<input>`, a `<textarea>`, or contenteditable — its text
 * area is a hidden textarea inside a `div.monaco-editor`, and much of the
 * time focus is on the editor container itself. So `isEditableTarget` misses
 * it entirely and it needs its own check.
 */
function isInsideCodeEditor(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.monaco-editor') !== null;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  if (isInsideCodeEditor(target)) {
    return true;
  }
  return target instanceof HTMLElement && target.isContentEditable;
}

function shouldForward(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || isOwnedShortcut(e)) {
    return false;
  }
  if (e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta' || e.key === 'Shift') {
    return false;
  }
  if (isEditableTarget(e.target)) {
    return false;
  }
  const hasModifier = e.ctrlKey || e.metaKey || e.altKey;
  if (!hasModifier && !FUNCTION_KEY.test(e.key)) {
    return false;
  }
  return true;
}

/**
 * No-ops when the page is top-level, which is every standalone `serve` and
 * desktop session — there is no host above it to forward anything to.
 */
export function installHostKeyboardBridge(): void {
  if (window.parent === window) {
    return;
  }
  window.addEventListener('keydown', (e) => {
    if (!shouldForward(e)) {
      return;
    }
    window.parent.postMessage({
      type: 'fluidcad-keydown',
      key: e.key,
      code: e.code,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
      repeat: e.repeat,
    }, '*');
  }, false);
}
