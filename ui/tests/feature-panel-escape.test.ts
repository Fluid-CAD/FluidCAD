// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { FeaturePanel } from '../src/interactive/create-feature/feature-panel';

// Escape closes an open feature dialog wherever focus is — picking in the
// viewport moves focus out of the dialog — unless the panel opts out (the
// sketch and gizmo panels, whose tools own the global Escape).

class TestPanel extends FeaturePanel {
  exits = 0;

  constructor(escapeAnywhere?: boolean) {
    super(document.body, {
      id: `test-panel-${Math.random()}`, title: 'Test', icon: '', escapeAnywhere,
      bodyHtml: '<input data-role="field" />',
    });
    this.onExit = () => this.exits++;
  }

  show(): void {
    this.shell.show();
  }

  get field(): HTMLInputElement {
    return this.role<HTMLInputElement>('field');
  }
}

const escape = (target: EventTarget) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

describe('FeaturePanel Escape', () => {
  it('closes the open dialog when focus is outside it (e.g. the viewport)', () => {
    const panel = new TestPanel();
    panel.show();
    escape(document.body);
    expect(panel.exits).toBe(1);
  });

  it('fires once for an Escape from inside the dialog', () => {
    const panel = new TestPanel();
    panel.show();
    escape(panel.field);
    expect(panel.exits).toBe(1);
  });

  it('ignores Escape while the dialog is hidden', () => {
    const panel = new TestPanel();
    escape(document.body);
    expect(panel.exits).toBe(0);
  });

  it('leaves an Escape typed into another input alone', () => {
    const panel = new TestPanel();
    panel.show();
    const other = document.createElement('input');
    document.body.appendChild(other);
    escape(other);
    expect(panel.exits).toBe(0);
  });

  it('a panel that opts out only hears Escape from inside it', () => {
    const panel = new TestPanel(false);
    panel.show();
    escape(document.body);
    expect(panel.exits).toBe(0);
    escape(panel.field);
    expect(panel.exits).toBe(1);
  });
});
