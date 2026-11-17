/**
 * Whether a keyboard event belongs to a text field rather than to FluidCAD's
 * shortcuts. Monaco owns <kbd>Ctrl+F</kbd>, <kbd>Ctrl+D</kbd>, <kbd>Ctrl+/</kbd>
 * and a long tail besides, so it counts as one too.
 */

/**
 * Monaco is not an `<input>`, a `<textarea>`, or contenteditable — its text
 * area is a hidden textarea inside a `div.monaco-editor`, and much of the
 * time focus is on the editor container itself. So the generic checks miss
 * it entirely and it needs its own.
 */
function isInsideCodeEditor(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.monaco-editor') !== null;
}

/**
 * The Agent panel's composer (`data-chat-composer`). A textarea, so the
 * bare-letter shortcuts already pass it by; the page's global chords that
 * reach into text fields on purpose (Ctrl+B, which toggles the editor even
 * from inside it) check this too, so typing to the agent never moves the
 * panels under it.
 */
export function isChatComposer(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-chat-composer]') !== null;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || isChatComposer(target)) {
    return true;
  }
  if (isInsideCodeEditor(target)) {
    return true;
  }
  return target instanceof HTMLElement && target.isContentEditable;
}
