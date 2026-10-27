import { ICON_CLOSE } from '../ui/icons';
import { PackageName } from './package-name';

/**
 * "New Package" in the desktop app: the one thing its native folder dialog
 * cannot ask is a name, so this small dialog asks it first (U2) — the whole
 * `@handle/name`, with the hint saying what the part before the slash is (U5)
 * — and the native dialog for the folder follows. The browser's folder picker
 * asks both at once and never shows this.
 *
 * Built like the engine dialog: a fixed overlay, a header with a close
 * button, a body and a footer of actions. `ask()` resolves with the name, or
 * null when the dialog was dismissed.
 */
export class PackageNameDialog {
  readonly element: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly problem: HTMLParagraphElement;
  private readonly createBtn: HTMLButtonElement;
  /** Settles the `ask()` under way. */
  private answer: ((name: string | null) => void) | null = null;

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'fixed inset-0 z-[300] bg-black/50 flex items-center justify-center p-4 hidden';
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-modal', 'true');
    this.element.setAttribute('aria-labelledby', 'fluidcad-package-name-title');
    this.element.innerHTML = `
      <div class="w-[460px] max-w-full flex flex-col bg-base-100 border border-base-content/10 rounded-lg shadow-[0_4px_24px_rgba(0,0,0,0.5)] overflow-hidden">
        <div class="flex items-center justify-between px-5 py-3 border-b border-base-content/10 shrink-0">
          <h3 id="fluidcad-package-name-title" class="text-sm font-medium text-base-content/90">New package</h3>
          <button data-ref="close" type="button" class="btn btn-ghost btn-square btn-xs text-base-content/60" title="Close" aria-label="Close">
            <span class="[&>svg]:size-4">${ICON_CLOSE}</span>
          </button>
        </div>
        <div class="px-5 py-4 grid gap-3">
          <p class="text-sm text-base-content/70">Name the package. FluidCAD then asks where it should live, and sets it up there.</p>
          <label class="grid gap-1.5">
            <span class="text-sm text-base-content/80">Package name</span>
            <input data-ref="name" type="text" spellcheck="false" autocomplete="off" placeholder="${PackageName.PLACEHOLDER}" class="input input-sm w-full font-mono" />
          </label>
          <p data-ref="hint" class="text-xs text-base-content/60">${PackageName.HINT}</p>
          <p data-ref="problem" class="hidden text-xs text-error break-words" aria-live="polite"></p>
        </div>
        <div class="flex items-center justify-end gap-2 px-5 py-3 border-t border-base-content/10 shrink-0">
          <button data-ref="cancel" type="button" class="btn btn-sm btn-ghost">Cancel</button>
          <button data-ref="create" type="button" class="btn btn-sm btn-primary">Create</button>
        </div>
      </div>
    `;
    const ref = <T extends HTMLElement>(name: string) => this.element.querySelector<T>(`[data-ref="${name}"]`)!;
    this.input = ref('name');
    this.problem = ref('problem');
    this.createBtn = ref('create');

    ref<HTMLButtonElement>('close').addEventListener('click', () => this.close());
    ref<HTMLButtonElement>('cancel').addEventListener('click', () => this.close());
    this.createBtn.addEventListener('click', () => this.submit());
    this.input.addEventListener('input', () => this.sync());
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.submit();
      }
    });
    this.element.addEventListener('mousedown', (event) => {
      if (event.target === this.element) {
        this.close();
      }
    });
    // Capture phase, like the other dialogs: this one is on top, so its Escape is its own.
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape' && this.isOpen()) {
          event.stopPropagation();
          event.preventDefault();
          this.close();
        }
      },
      true,
    );
  }

  /** Showing, in the page: a dialog that left the document keeps no hold on its keys. */
  isOpen(): boolean {
    return this.element.isConnected && !this.element.classList.contains('hidden');
  }

  /** Show the dialog, empty; the name once Create is pressed with a valid one, null when dismissed. */
  ask(): Promise<string | null> {
    // Asked again while up (the menu, then the button): the first asker gets nothing.
    this.answer?.(null);
    this.input.value = '';
    this.sync();
    this.element.classList.remove('hidden');
    this.input.focus();
    return new Promise((resolve) => {
      this.answer = resolve;
    });
  }

  close(): void {
    this.element.classList.add('hidden');
    const answer = this.answer;
    this.answer = null;
    answer?.(null);
  }

  /** What the field holds, trimmed. */
  get value(): string {
    return this.input.value.trim();
  }

  private submit(): void {
    const name = this.value;
    if (!PackageName.isValid(name)) {
      // Pressed on an empty field: the sentence appears where the hint is.
      this.showProblem(PackageName.PROBLEM);
      return;
    }
    this.element.classList.add('hidden');
    const answer = this.answer;
    this.answer = null;
    answer?.(name);
  }

  /** The sentence for a name that does not fit, and Create only once one does. */
  private sync(): void {
    const name = this.value;
    this.showProblem(PackageName.problem(name));
    this.createBtn.disabled = !PackageName.isValid(name);
  }

  private showProblem(sentence: string | null): void {
    this.problem.textContent = sentence ?? '';
    this.problem.classList.toggle('hidden', sentence === null);
  }
}
