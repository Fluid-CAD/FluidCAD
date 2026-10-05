// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { ExtrudePanel } from '../src/interactive/create-feature/extrude-panel';
import './dom-reset';

// Who owns viewport clicks in the extrude dialog. Region picking suspends
// the viewer's own picking, so while it is live the face and scope slots
// draw quiet, and any path that arms one of them — a click on the slot, the
// direction entering "Up to face" — must tell the service so it ends the
// region pick and the face click lands on a face again.

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

describe('ExtrudePanel — viewport pick ownership', () => {
  it('arms the face slot when the direction enters "Up to face" — no claim while nothing else holds the viewport', () => {
    const { container, claims } = openPanel();
    setDirection(container, 'to-face');
    expect(faceSlotArmed(container)).toBe(true);
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
    // The armed slot clicked again with nothing in the way is not a change.
    clickFaceSlot(container);
    expect(claims).toHaveLength(0);
    panel.setRegionPickLive(true);
    clickFaceSlot(container);
    expect(claims).toHaveLength(1);
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
