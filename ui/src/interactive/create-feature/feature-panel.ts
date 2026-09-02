import { PanelShell } from './panel-controls';
import { ExpressionField } from '../../ui/expression-field';
import { applyUnitDefaults } from '../../units/apply-unit-defaults';
import { sceneUnit } from '../../units/scene-unit';

/**
 * The base every create/edit feature dialog panel shares: the PanelShell with
 * its Escape wiring, the Apply / Exit footer, the preview/message/enable
 * delegates, and the ExpressionField wiring (Enter applies, typing fires
 * change). Subclasses pass their body HTML — it renders between the title and
 * the footer — and wire their controls off `this.body`.
 */
export abstract class FeaturePanel {
  onChange?: () => void;
  onApply?: () => void;
  onExit?: () => void;

  protected readonly shell: PanelShell;
  protected readonly body: HTMLDivElement;
  private readonly applyBtn: HTMLButtonElement;

  constructor(
    container: HTMLElement,
    opts: {
      id: string; title: string; icon: string; bodyHtml: string;
      /** Footer's dismiss label; 'Cancel' for the one-shot sketch tools. */
      exitLabel?: string;
    },
  ) {
    this.shell = new PanelShell(container, opts.id, opts.title, opts.icon);
    this.shell.onEscape = () => this.onExit?.();
    this.body = this.shell.body;
    this.body.insertAdjacentHTML('beforeend', `
      ${opts.bodyHtml}
      <div class="flex items-center gap-2 pt-1">
        <button data-role="apply" class="btn btn-primary btn-sm flex-1">Apply</button>
        <button data-role="exit" class="btn btn-ghost btn-sm">${opts.exitLabel ?? 'Exit'}</button>
      </div>
    `);
    // Length defaults are authored in mm; rewrite them for the document
    // unit now and whenever it changes — but never under an open dialog,
    // whose fields may hold the user's edit or an edit-mode seed.
    applyUnitDefaults(this.body);
    sceneUnit.subscribe(() => {
      if (!this.shell.isVisible) {
        applyUnitDefaults(this.body);
      }
    });
    this.applyBtn = this.role('apply');
    this.applyBtn.addEventListener('click', () => this.onApply?.());
    this.role('exit').addEventListener('click', () => this.onExit?.());
  }

  get isVisible(): boolean {
    return this.shell.isVisible;
  }

  hide(): void {
    this.shell.hide();
  }

  setPreview(text: string | null): void {
    this.shell.setPreview(text);
  }

  setMessage(text: string | null): void {
    this.shell.setMessage(text);
  }

  setApplyEnabled(enabled: boolean): void {
    this.applyBtn.disabled = !enabled;
  }

  /** The body element carrying `data-role="name"`. */
  protected role<T extends HTMLElement = HTMLElement>(name: string): T {
    return this.body.querySelector<T>(`[data-role="${name}"]`)!;
  }

  /**
   * Wrap a dialog input in an ExpressionField wired to the panel: Enter
   * applies, typing fires change, and the field owns the input's keyboard
   * handling (variable dropdown, type="text" for identifiers).
   */
  protected enhance(role: string): ExpressionField {
    const input = this.role<HTMLInputElement>(role);
    const field = new ExpressionField(input);
    field.onSubmit = () => this.onApply?.();
    input.addEventListener('input', () => this.onChange?.());
    return field;
  }
}
