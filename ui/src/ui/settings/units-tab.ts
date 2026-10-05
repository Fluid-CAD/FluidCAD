import { LENGTH_UNITS, isLengthUnit, type LengthUnit } from '../../units/units';
import { newProjectDefaults } from './new-project-defaults';
import { SELECT, field, type PersistPreference, type SettingsContext, type SettingsTab } from './settings-tab';

/** The unit a new project is created in. Existing projects are not touched. */
export class UnitsTab implements SettingsTab {
  readonly id = 'units';
  readonly label = 'Units';
  private unit!: HTMLSelectElement;
  private draft: LengthUnit = newProjectDefaults.current.unit;

  mount(root: HTMLElement, ctx: SettingsContext): void {
    this.unit = document.createElement('select');
    this.unit.className = SELECT;
    for (const { value, label } of LENGTH_UNITS) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = `${value} (${label})`;
      this.unit.appendChild(option);
    }
    this.unit.addEventListener('change', () => {
      const unit = this.unit.value;
      if (!isLengthUnit(unit)) {
        return;
      }
      this.draft = unit;
      ctx.changed();
    });
    root.appendChild(field('Unit for new projects', this.unit, 'Existing projects keep their unit.'));

    this.sync();
  }

  sync(): void {
    this.draft = newProjectDefaults.current.unit;
    this.unit.value = this.draft;
  }

  isDirty(): boolean {
    return this.draft !== newProjectDefaults.current.unit;
  }

  save(persist: PersistPreference): void {
    if (!this.isDirty()) {
      return;
    }
    newProjectDefaults.update({ unit: this.draft });
    persist('defaultProjectUnit', this.draft);
  }
}
