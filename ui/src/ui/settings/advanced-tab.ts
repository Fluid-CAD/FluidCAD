import { FIELD_LABEL, type SettingsContext, type SettingsTab } from './settings-tab';

/**
 * The one control that acts at once rather than on Save: put every setting
 * back to its default, behind an inline confirmation. A reset is an action
 * on the stored file, not a draft, so it does not wait for Save and it
 * drops whatever drafts the other tabs hold.
 */
export class AdvancedTab implements SettingsTab {
  readonly id = 'advanced';
  readonly label = 'Advanced';
  private resetBtn!: HTMLButtonElement;
  private confirmRow!: HTMLDivElement;
  private status!: HTMLParagraphElement;

  mount(root: HTMLElement, ctx: SettingsContext): void {
    const label = document.createElement('p');
    label.className = `${FIELD_LABEL} mb-2`;
    label.textContent = 'Reset every setting to its default.';
    root.appendChild(label);

    this.resetBtn = document.createElement('button');
    this.resetBtn.type = 'button';
    this.resetBtn.className = 'btn btn-sm btn-outline btn-error';
    this.resetBtn.textContent = 'Reset all to defaults';
    this.resetBtn.addEventListener('click', () => this.askConfirm(true));
    root.appendChild(this.resetBtn);

    this.confirmRow = document.createElement('div');
    this.confirmRow.className = 'hidden flex-wrap items-center gap-2 mt-3';
    this.confirmRow.innerHTML = `<span class="text-xs text-base-content/70">This applies now and cannot be undone.</span>`;
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn btn-sm btn-error';
    confirm.textContent = 'Reset';
    confirm.addEventListener('click', () => void this.reset(ctx));
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-sm btn-ghost';
    cancel.textContent = 'Keep my settings';
    cancel.addEventListener('click', () => this.askConfirm(false));
    this.confirmRow.appendChild(confirm);
    this.confirmRow.appendChild(cancel);
    root.appendChild(this.confirmRow);

    this.status = document.createElement('p');
    this.status.className = 'hidden text-xs mt-3';
    root.appendChild(this.status);
  }

  sync(): void {
    this.askConfirm(false);
  }

  isDirty(): boolean {
    return false;
  }

  save(): void {
    // Nothing is drafted here.
  }

  private askConfirm(open: boolean): void {
    // `hidden` and `flex` both set display, so only one may be present.
    this.confirmRow.classList.toggle('hidden', !open);
    this.confirmRow.classList.toggle('flex', open);
    this.resetBtn.classList.toggle('hidden', open);
    this.status.classList.add('hidden');
  }

  private async reset(ctx: SettingsContext): Promise<void> {
    const ok = await ctx.resetAll();
    this.askConfirm(false);
    this.status.textContent = ok
      ? 'Every setting is back to its default.'
      : 'The settings could not be reset. The engine did not answer; try again.';
    this.status.className = ok ? 'text-xs mt-3 text-success' : 'text-xs mt-3 text-error';
  }
}
