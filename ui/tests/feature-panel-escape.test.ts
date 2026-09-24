// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import './dom-reset';
import { FeaturePanel } from '../src/interactive/create-feature/feature-panel';
import type { EscapeScope } from '../src/interactive/create-feature/panel-controls';

// Escape closes an open feature dialog wherever focus is — picking in the
// viewport moves focus out of the dialog — with the most recently opened
// dialog going first. The sketch-mode dialogs opt out (`escape: 'inside'`):
// the sketch toolbar's Escape exits their tool, which closes them.

class TestPanel extends FeaturePanel {
  exits = 0;

  constructor(escape?: EscapeScope) {
    super(document.body, {
      id: `test-panel-${Math.random()}`, title: 'Test', icon: '', escape,
      bodyHtml: '<input data-role="field" />',
    });
    this.onExit = () => {
      this.exits++;
      this.hide();
    };
  }

  show(): void {
    this.shell.show();
  }

  get field(): HTMLInputElement {
    return this.role<HTMLInputElement>('field');
  }
}

const panels: TestPanel[] = [];

function open(escape?: EscapeScope): TestPanel {
  const panel = new TestPanel(escape);
  panel.show();
  panels.push(panel);
  return panel;
}

afterEach(() => {
  for (const panel of panels.splice(0)) {
    panel.hide();
  }
});

const escape = (target: EventTarget, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

describe('FeaturePanel Escape', () => {
  it('closes the open dialog when focus is outside it (e.g. the viewport)', () => {
    const panel = open();
    escape(document.body);
    expect(panel.exits).toBe(1);
  });

  it('fires once for an Escape from inside the dialog', () => {
    const panel = open();
    escape(panel.field);
    expect(panel.exits).toBe(1);
  });

  it('ignores Escape once the dialog is hidden', () => {
    const panel = open();
    panel.hide();
    escape(document.body);
    expect(panel.exits).toBe(0);
  });

  it('leaves an Escape typed into another input alone', () => {
    const panel = open();
    const other = document.createElement('input');
    document.body.appendChild(other);
    escape(other);
    expect(panel.exits).toBe(0);
  });

  it('leaves an Escape another handler already consumed alone', () => {
    const panel = open();
    document.body.addEventListener('keydown', (e) => e.preventDefault(), { once: true });
    escape(document.body);
    expect(panel.exits).toBe(0);
  });

  it('closes the most recently opened dialog first', () => {
    const first = open();
    const second = open();
    escape(document.body);
    expect(second.exits).toBe(1);
    expect(first.exits).toBe(0);
    escape(document.body);
    expect(first.exits).toBe(1);
  });

  it('a re-shown dialog moves back to the front', () => {
    const first = open();
    const second = open();
    first.show();
    escape(document.body);
    expect(first.exits).toBe(1);
    expect(second.exits).toBe(0);
  });

  it('a sketch-mode dialog only hears Escape from inside it', () => {
    const panel = open('inside');
    escape(document.body);
    expect(panel.exits).toBe(0);
    escape(panel.field);
    expect(panel.exits).toBe(1);
  });
});
