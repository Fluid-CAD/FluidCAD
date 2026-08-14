// @vitest-environment jsdom
// The pen-button connector editor docks directly LEFT of the mate dialog's
// card. The mate panel's dock column right-aligns wider rows (the statement
// preview) past the card's left edge — measuring the stretched root instead
// of the card put this editor a preview-width too far left.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorPropsEditor } from '../src/interactive/assembly-mate/connector-props-editor';
import type { MateSlotState } from '../src/interactive/assembly-mate/mate-service';
import type { Viewer } from '../src/viewer';

function rect(left: number, width: number): DOMRect {
  return {
    left, width, right: left + width, top: 100, bottom: 500, height: 400, x: left, y: 100,
    toJSON: () => ({}),
  } as DOMRect;
}

const SLOT: MateSlotState = {
  instanceId: 'i1',
  connectorId: 'c1',
  instanceLine: 3,
  connectorName: 'c1',
  instanceName: 'Extrusion-80x80',
  filePath: '/a.assembly.js',
};

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('connector props editor placement', () => {
  it('docks beside the mate dialog CARD, not its wider preview row', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ name: 'c1', rotate: null, offset: null }),
    })));

    // The mate dialog: a fixed-width card plus a statement-preview row that
    // stretches the root's bounding rect 100px further left.
    const mateRoot = document.createElement('div');
    mateRoot.id = 'fluidcad-mate-panel';
    const mateCard = document.createElement('div');
    mateCard.setAttribute('data-role', 'body');
    mateRoot.appendChild(mateCard);
    document.body.appendChild(mateRoot);
    mateRoot.getBoundingClientRect = () => rect(340, 340);
    mateCard.getBoundingClientRect = () => rect(440, 240);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const viewer = {
      getAssemblyController: () => ({
        getConnectorSourceLocation: () => ({ filePath: '/p.fluid.js', line: 3 }),
      }),
    } as unknown as Viewer;

    const editor = new ConnectorPropsEditor(container, viewer);
    await editor.open(SLOT);

    const root = document.getElementById('fluidcad-connector-props-panel')!;
    expect(editor.isOpen).toBe(true);
    // 8px gutter left of the CARD's edge (offsetParent is null in jsdom, so
    // the host right edge falls back to the window width).
    expect(root.style.right).toBe(`${Math.round(window.innerWidth - 440 + 8)}px`);
  });
});
