import type { TimelineSketchChildren } from '../../api';
import { viewerSettings } from '../../scene/viewer-settings';
import { SELECT, field, toggleRow, type PersistPreference, type SettingsContext, type SettingsTab } from './settings-tab';

interface TimelineDraft {
  timelineSketchChildren: TimelineSketchChildren;
  timelineShowConstraints: boolean;
  timelineShowRegions: boolean;
}

const SKETCH_CHILDREN_OPTIONS: readonly { value: TimelineSketchChildren; label: string }[] = [
  { value: 'all', label: 'Show all' },
  { value: 'editable', label: 'Show only editable features' },
];

function currentDraft(): TimelineDraft {
  const { timelineSketchChildren, timelineShowConstraints, timelineShowRegions } = viewerSettings.current;
  return { timelineSketchChildren, timelineShowConstraints, timelineShowRegions };
}

/** Which rows the History panel lists under a sketch: its children, its constraints group, its regions group. */
export class TimelineTab implements SettingsTab {
  readonly id = 'timeline';
  readonly label = 'Timeline';
  private children!: HTMLSelectElement;
  private constraints!: HTMLInputElement;
  private regions!: HTMLInputElement;
  private draft: TimelineDraft = currentDraft();

  mount(root: HTMLElement, ctx: SettingsContext): void {
    this.children = document.createElement('select');
    this.children.className = SELECT;
    for (const { value, label } of SKETCH_CHILDREN_OPTIONS) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      this.children.appendChild(option);
    }
    this.children.addEventListener('change', () => {
      const value = this.children.value;
      if (value !== 'all' && value !== 'editable') {
        return;
      }
      this.draft.timelineSketchChildren = value;
      ctx.changed();
    });
    root.appendChild(field('Sketch children', this.children, 'Editable features are the ones with an edit dialog, such as offset, projection and intersect.'));

    const constraints = toggleRow('Show constraints', (timelineShowConstraints) => {
      this.draft.timelineShowConstraints = timelineShowConstraints;
      ctx.changed();
    });
    this.constraints = constraints.input;
    root.appendChild(constraints.row);

    const regions = toggleRow('Show regions', (timelineShowRegions) => {
      this.draft.timelineShowRegions = timelineShowRegions;
      ctx.changed();
    });
    this.regions = regions.input;
    root.appendChild(regions.row);

    this.sync();
  }

  sync(): void {
    this.draft = currentDraft();
    this.children.value = this.draft.timelineSketchChildren;
    this.constraints.checked = this.draft.timelineShowConstraints;
    this.regions.checked = this.draft.timelineShowRegions;
  }

  isDirty(): boolean {
    const current = currentDraft();
    return this.draft.timelineSketchChildren !== current.timelineSketchChildren
      || this.draft.timelineShowConstraints !== current.timelineShowConstraints
      || this.draft.timelineShowRegions !== current.timelineShowRegions;
  }

  save(persist: PersistPreference): void {
    const current = currentDraft();
    for (const key of ['timelineSketchChildren', 'timelineShowConstraints', 'timelineShowRegions'] as const) {
      if (this.draft[key] !== current[key]) {
        persist(key, this.draft[key]);
      }
    }
    viewerSettings.update({ ...this.draft });
  }
}
