import { viewerSettings } from '../../scene/viewer-settings';
import { field, numberField, type PersistPreference, type SettingsContext, type SettingsTab } from './settings-tab';

export const RADIUS_PX_MIN = 2;
export const RADIUS_PX_MAX = 80;

/** How far the cursor reaches while sketching: the snap radius and the pick radius, in screen pixels. */
export class SketchTab implements SettingsTab {
  readonly id = 'sketch';
  readonly label = 'Sketch';
  private snap!: HTMLInputElement;
  private pick!: HTMLInputElement;
  private draft = { snapRadiusPx: viewerSettings.current.snapRadiusPx, pickRadiusPx: viewerSettings.current.pickRadiusPx };

  mount(root: HTMLElement, ctx: SettingsContext): void {
    this.snap = numberField(RADIUS_PX_MIN, RADIUS_PX_MAX, (snapRadiusPx) => {
      this.draft.snapRadiusPx = snapRadiusPx;
      ctx.changed();
    });
    root.appendChild(field('Snap radius (px)', this.snap, 'Distance to a vertex, axis or grid line that pulls the cursor onto it.'));

    this.pick = numberField(RADIUS_PX_MIN, RADIUS_PX_MAX, (pickRadiusPx) => {
      this.draft.pickRadiusPx = pickRadiusPx;
      ctx.changed();
    });
    root.appendChild(field('Pick radius (px)', this.pick, 'Distance to a line, arc or vertex that highlights it.'));

    this.sync();
  }

  sync(): void {
    const { snapRadiusPx, pickRadiusPx } = viewerSettings.current;
    this.draft = { snapRadiusPx, pickRadiusPx };
    this.snap.value = String(snapRadiusPx);
    this.pick.value = String(pickRadiusPx);
  }

  isDirty(): boolean {
    const { snapRadiusPx, pickRadiusPx } = viewerSettings.current;
    return this.draft.snapRadiusPx !== snapRadiusPx || this.draft.pickRadiusPx !== pickRadiusPx;
  }

  save(persist: PersistPreference): void {
    const { snapRadiusPx, pickRadiusPx } = viewerSettings.current;
    if (this.draft.snapRadiusPx !== snapRadiusPx) {
      persist('snapRadiusPx', this.draft.snapRadiusPx);
    }
    if (this.draft.pickRadiusPx !== pickRadiusPx) {
      persist('pickRadiusPx', this.draft.pickRadiusPx);
    }
    viewerSettings.update({ ...this.draft });
  }
}
