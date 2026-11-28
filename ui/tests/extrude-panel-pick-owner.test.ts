// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { ExtrudePanel } from '../src/interactive/create-feature/extrude-panel';
import './dom-reset';

// Who owns viewport clicks in the extrude dialog. A face click lands in the
// armed slot: the profile (the face to extrude — the default), the
// up-to-face target, or the scope list. Region picking suspends the viewer's
// own picking, so while it is live the face and scope slots draw quiet, and
// any path that arms one of them — a click on the slot, the direction
// entering "Up to face" — must tell the service so it ends the region pick
// and the face click lands on a face again.

const opened: ExtrudePanel[] = [];

function openPanel() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const panel = new ExtrudePanel(container);
  const claims: number[] = [];
  panel.onArmedPickChange = () => claims.push(claims.length + 1);
  panel.show([]);
  opened.push(panel);
  return { panel, container, claims };
}

// An open feature panel stays registered for Escape until it hides — leave
// none behind for the next file's dialogs.
afterEach(() => {
  for (const panel of opened.splice(0)) {
    panel.hide();
  }
});

function setDirection(container: HTMLElement, value: string): void {
  const select = container.querySelector<HTMLSelectElement>('[data-role="direction"]')!;
  select.value = value;
  select.dispatchEvent(new Event('change'));
}

function faceSlotArmed(container: HTMLElement): boolean {
  const prompt = container.querySelector<HTMLElement>('[data-role="face-slot"] .border')!;
  return prompt.classList.contains('border-primary');
}

function clickFaceSlot(container: HTMLElement): void {
  container.querySelector<HTMLElement>('[data-role="face-slot"]')!.click();
}

function profileSlotArmed(container: HTMLElement): boolean {
  const box = container.querySelector<HTMLElement>('[data-role="profile-slot"] .border')!;
  return box.classList.contains('border-primary');
}

/** The profile slot's own pick box — not the region row beneath it. */
function clickProfileSlot(container: HTMLElement): void {
  container.querySelector<HTMLElement>('[data-role="profile-slot"] .border')!.click();
}

function hidden(container: HTMLElement, role: string): boolean {
  return container.querySelector<HTMLElement>(`[data-role="${role}"]`)!.classList.contains('hidden');
}

function thinToggle(container: HTMLElement): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('[data-role="thin"]')!;
}

function setRemove(container: HTMLElement): void {
  const tab = [...container.querySelectorAll<HTMLElement>('[data-role="tabs"] *')]
    .find(el => el.children.length === 0 && el.textContent?.trim() === 'Remove')!;
  tab.click();
}

describe('ExtrudePanel — viewport pick ownership', () => {
  it('opens with the profile slot holding the viewport — a face click is the face to extrude', () => {
    const { panel, container, claims } = openPanel();
    expect(panel.profilePickArmed).toBe(true);
    expect(profileSlotArmed(container)).toBe(true);
    expect(claims).toHaveLength(0);
  });

  it('hands the viewport from the profile slot to the face slot when the direction enters "Up to face"', () => {
    const { panel, container, claims } = openPanel();
    setDirection(container, 'to-face');
    expect(faceSlotArmed(container)).toBe(true);
    expect(profileSlotArmed(container)).toBe(false);
    expect(panel.profilePickArmed).toBe(false);
    expect(claims).toHaveLength(1);
  });

  it('takes the viewport back for the profile when its slot is clicked, and when the direction leaves "Up to face"', () => {
    const { panel, container, claims } = openPanel();
    setDirection(container, 'to-face');
    clickProfileSlot(container);
    expect(panel.profilePickArmed).toBe(true);
    expect(profileSlotArmed(container)).toBe(true);
    expect(faceSlotArmed(container)).toBe(false);
    expect(claims).toHaveLength(2);

    clickFaceSlot(container);
    expect(panel.profilePickArmed).toBe(false);
    setDirection(container, 'one');
    expect(panel.profilePickArmed).toBe(true);
    expect(profileSlotArmed(container)).toBe(true);
  });

  it('keeps a live region pick when the profile slot is clicked — the regions are the profile\'s own', () => {
    const { panel, container, claims } = openPanel();
    panel.setRegionPickLive(true);
    expect(profileSlotArmed(container)).toBe(true);
    clickProfileSlot(container);
    expect(claims).toHaveLength(0);
  });

  it('does not claim it for the distance modes or the first/last-face literals', () => {
    const { container, claims } = openPanel();
    setDirection(container, 'symmetric');
    setDirection(container, 'first-face');
    setDirection(container, 'last-face');
    setDirection(container, 'two');
    expect(claims).toHaveLength(0);
  });

  it('quiets the face slot while a region pick is live and re-arms it when it ends', () => {
    const { panel, container } = openPanel();
    setDirection(container, 'to-face');
    expect(faceSlotArmed(container)).toBe(true);
    panel.setRegionPickLive(true);
    expect(faceSlotArmed(container)).toBe(false);
    panel.setRegionPickLive(false);
    expect(faceSlotArmed(container)).toBe(true);
  });

  it('claims the viewport back when the already-armed face slot is clicked during a region pick', () => {
    const { panel, container, claims } = openPanel();
    setDirection(container, 'to-face');
    expect(claims).toHaveLength(1);
    // The armed slot clicked again with nothing in the way is not a change.
    clickFaceSlot(container);
    expect(claims).toHaveLength(1);
    panel.setRegionPickLive(true);
    clickFaceSlot(container);
    expect(claims).toHaveLength(2);
    // The service ends the pick and reports it off; the slot is armed again.
    panel.setRegionPickLive(false);
    expect(faceSlotArmed(container)).toBe(true);
  });

  it('claims the viewport when "Up to face" is entered during a region pick', () => {
    const { panel, container, claims } = openPanel();
    panel.setRegionPickLive(true);
    setDirection(container, 'to-face');
    expect(claims).toHaveLength(1);
    panel.setRegionPickLive(false);
    expect(faceSlotArmed(container)).toBe(true);
  });

  it('keeps its own values() gate: no face means no apply', () => {
    const { panel, container } = openPanel();
    setDirection(container, 'to-face');
    expect(panel.values()).toEqual({ error: 'Pick the face to extrude up to.' });
    panel.setFaceChip('Picked face');
    expect(panel.values()).not.toHaveProperty('error');
  });
});

describe('ExtrudePanel — a face as the profile', () => {
  it('shows the picked face in the profile slot and hands the slot back when it is dropped', () => {
    const { panel, container } = openPanel();
    expect(panel.profileSelection()).toBeNull();
    panel.setProfileFace('Picked face');
    expect(panel.profileSelection()).toEqual({ kind: 'face', label: 'Picked face' });
    expect(panel.selectedOption()).toBeNull();
    expect(panel.profileIsFace()).toBe(true);
    expect(container.querySelector('[data-role="profile-slot"]')!.textContent).toContain('Picked face');
    panel.setProfileFace(null);
    expect(panel.profileSelection()).toBeNull();
    expect(panel.profileIsFace()).toBe(false);
  });

  it('parks what a face cannot carry: drill, thin walls and through-all', () => {
    const { panel, container } = openPanel();
    setRemove(container);
    expect(hidden(container, 'through-wrap')).toBe(false);
    thinToggle(container).click();
    expect(thinToggle(container).checked).toBe(true);

    panel.setProfileFace('Picked face');
    expect(hidden(container, 'drill-wrap')).toBe(true);
    expect(hidden(container, 'through-wrap')).toBe(true);
    expect(thinToggle(container).disabled).toBe(true);
    expect(thinToggle(container).checked).toBe(false);
    expect(panel.values()).toMatchObject({ op: 'remove', distance: 25, thin: null, drill: true });

    panel.setProfileFace(null);
    expect(hidden(container, 'drill-wrap')).toBe(false);
    expect(hidden(container, 'through-wrap')).toBe(false);
    expect(thinToggle(container).disabled).toBe(false);
  });

  it('never reads a through-all left ticked from before the face was picked', () => {
    const { panel, container } = openPanel();
    setRemove(container);
    const through = container.querySelector<HTMLInputElement>('[data-role="through"]')!;
    through.click();
    expect(panel.values()).toMatchObject({ distance: null });
    panel.setProfileFace('Picked face');
    expect(panel.values()).toMatchObject({ distance: 25 });
  });

  it('reads an edited statement\'s face-selector profile as its expression, and parks the same controls once it resolves to a face', () => {
    const { panel, container } = openPanel();
    panel.showEdit({
      op: 'add', distance: 10, distance2: null, symmetric: false, draft: null, endOffset: null,
      drill: true, thin: null, profileLabel: 'e.endFaces()', toFaceLabel: null, toFaceKind: null,
    });
    expect(container.querySelector('[data-role="profile-slot"]')!.textContent).toContain('Current: e.endFaces()');
    expect(panel.profileIsFace()).toBe(false);
    panel.setKeptProfileIsFace(true);
    expect(panel.profileIsFace()).toBe(true);
    expect(hidden(container, 'drill-wrap')).toBe(true);
    // A re-picked face takes the slot; its removal goes back to the kept profile.
    panel.setProfileFace('Picked face');
    expect(panel.profileSelection()).toEqual({ kind: 'face', label: 'Picked face' });
    panel.setProfileFace(null);
    expect(panel.profileSelection()).toEqual({ kind: 'keep' });
  });
});
