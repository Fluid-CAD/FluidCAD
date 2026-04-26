/**
 * Forwards unhandled modifier-bearing keyboard shortcuts from the FluidCAD UI
 * (running inside an iframe in a VSCode webview) up to the parent webview
 * document, where a small re-dispatcher hands them to VSCode's keybinding
 * service. Local UI handlers opt out by calling `e.preventDefault()`.
 */

const FUNCTION_KEY = /^F([1-9]|1[0-9])$/;

/** Hook for FluidCAD-owned shortcuts that don't preventDefault. Empty by default. */
export function isOwnedShortcut(_e: KeyboardEvent): boolean {
  return false;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
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

export function installVSCodeKeyboardBridge(): void {
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
