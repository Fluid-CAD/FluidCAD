/**
 * Inline rename for a file tab. The field edits what the tab *shows*: a
 * model's stem (`bracket`, with `Part` said underneath), a helper's whole
 * basename (`init.js`). {@link renamedBasename} turns what was typed back
 * into a file name the same way.
 */

/** Model suffixes, longest first so `.assembly.js` isn't mistaken for `.js`. */
const MODEL_SUFFIXES = ['.assembly.js', '.part.js', '.fluid.js'] as const;

/** `bracket.part.js` → `.part.js`; null for a file that is not a model. */
export function modelSuffixOf(basename: string): string | null {
  for (const suffix of MODEL_SUFFIXES) {
    if (basename.endsWith(suffix) && basename.length > suffix.length) {
      return suffix;
    }
  }
  return null;
}

/** What the rename field starts out holding: the stem for a model, the basename otherwise. */
export function editableNameOf(basename: string): string {
  const suffix = modelSuffixOf(basename);
  return suffix ? basename.slice(0, -suffix.length) : basename;
}

/**
 * The file name a rename field's text stands for.
 *
 * - A model keeps its suffix — `arm` under `bracket.part.js` is `arm.part.js` —
 *   unless the text spells out a model suffix of its own, which is how a part
 *   becomes an assembly.
 * - A helper's text is the file name; one typed without an extension gets `.js`.
 *
 * Null when nothing would change, or when there is nothing to name.
 */
export function renamedBasename(basename: string, typed: string): string | null {
  const name = typed.trim();
  if (name === '' || name.endsWith('/')) {
    return null;
  }
  const suffix = modelSuffixOf(basename);
  let next: string;
  if (suffix) {
    next = modelSuffixOf(name) ? name : `${name}${suffix}`;
  } else {
    next = /\.[a-z0-9]+$/i.test(name) ? name : `${name}.js`;
  }
  return next === basename ? null : next;
}

export interface RenameFieldHandlers {
  onInput(draft: string): void;
  onCommit(typed: string): void;
  onCancel(): void;
}

/**
 * The input that takes a tab label's place. Enter commits, Escape cancels,
 * and so does clicking away — a blur commits too, the way the parts panel's
 * rename does, but only while the field is still in the document: a strip
 * re-render tears the field down and rebuilds it from the draft, and that
 * teardown must not count as the user leaving.
 */
export function buildRenameField(draft: string, handlers: RenameFieldHandlers): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = draft;
  input.spellcheck = false;
  input.dataset.renameInput = '';
  input.className =
    'flex-1 min-w-0 w-full bg-base-100 border border-base-content/20 rounded px-1 py-0 ' +
    'text-sm leading-tight text-base-content outline-none focus:border-primary';
  let settled = false;
  const settle = (action: () => void) => {
    if (!settled) {
      settled = true;
      action();
    }
  };
  input.addEventListener('input', () => handlers.onInput(input.value));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      settle(() => handlers.onCommit(input.value));
    } else if (event.key === 'Escape') {
      event.preventDefault();
      settle(() => handlers.onCancel());
    }
    // Neither the strip's shortcuts nor the scene's should see typing here.
    event.stopPropagation();
  });
  input.addEventListener('blur', () => {
    if (input.isConnected) {
      settle(() => handlers.onCommit(input.value));
    }
  });
  // A press in the field is typing, not a tab activation or a drag.
  input.addEventListener('click', (event) => event.stopPropagation());
  return input;
}
