// The connector edit dialog seeds its live ghost from the built connector's
// own frame — the only frame a timeline row carries. Getting the anchor back
// out of it means undoing exactly what the statement's chain did, so the
// dialog's rotation and offset re-apply from the anchor instead of compounding
// onto what the statement already wrote.
import { describe, it, expect } from 'vitest';
import { adjustConnectorFrame, unadjustConnectorFrame } from '../src/interactive/create-feature/connector-ghost';
import type { ConnectorFrameData } from '../src/meshes/containers/connector-mesh';

/** A tilted frame — axis-aligned math would hide an axis mix-up. */
const ANCHOR: ConnectorFrameData = {
  origin: { x: 10, y: -4, z: 2.5 },
  xDirection: { x: 0.6, y: 0.8, z: 0 },
  yDirection: { x: -0.8, y: 0.6, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
};

function expectFrameClose(actual: ConnectorFrameData, expected: ConnectorFrameData): void {
  for (const key of ['origin', 'xDirection', 'yDirection', 'normal'] as const) {
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(actual[key][axis], `${key}.${axis}`).toBeCloseTo(expected[key][axis], 10);
    }
  }
}

describe('unadjustConnectorFrame', () => {
  const CASES: { name: string; rotate: { axis: 'x' | 'y' | 'z'; angle: number }; offset: [number, number, number] }[] = [
    { name: 'no adjustments', rotate: { axis: 'z', angle: 0 }, offset: [0, 0, 0] },
    { name: 'rotation only', rotate: { axis: 'z', angle: 90 }, offset: [0, 0, 0] },
    { name: 'offset only', rotate: { axis: 'z', angle: 0 }, offset: [3, -2, 7] },
    { name: 'rotation then offset', rotate: { axis: 'z', angle: 90 }, offset: [0, 0, 5] },
    { name: 'rotation about x', rotate: { axis: 'x', angle: 180 }, offset: [1, 2, 3] },
    { name: 'rotation about y', rotate: { axis: 'y', angle: 270 }, offset: [-1.5, 0, 0.25] },
    { name: 'a hand-written angle', rotate: { axis: 'y', angle: 37 }, offset: [4, 4, 4] },
  ];

  for (const { name, rotate, offset } of CASES) {
    it(`inverts ${name}`, () => {
      const built = adjustConnectorFrame(ANCHOR, rotate, offset);
      expectFrameClose(unadjustConnectorFrame(built, rotate, offset), ANCHOR);
    });
  }

  it('re-dialling from the recovered anchor does not compound the statement\'s own chain', () => {
    // What the edit dialog actually does: recover the anchor from the built
    // frame, then apply the NEW field values. The result must match building
    // that connector from scratch with those values.
    const statement = { rotate: { axis: 'z' as const, angle: 90 }, offset: [0, 0, 5] as [number, number, number] };
    const dialled = { rotate: { axis: 'x' as const, angle: 180 }, offset: [2, 0, 0] as [number, number, number] };

    const built = adjustConnectorFrame(ANCHOR, statement.rotate, statement.offset);
    const anchor = unadjustConnectorFrame(built, statement.rotate, statement.offset);
    const preview = adjustConnectorFrame(anchor, dialled.rotate, dialled.offset);

    expectFrameClose(preview, adjustConnectorFrame(ANCHOR, dialled.rotate, dialled.offset));
    // And it is genuinely different from the frame on screen — the ghost moves.
    expect(preview.origin.x).not.toBeCloseTo(built.origin.x, 6);
  });

  it('normalizes the axes it is handed', () => {
    const scaled: ConnectorFrameData = {
      origin: { x: 0, y: 0, z: 0 },
      xDirection: { x: 3, y: 0, z: 0 },
      yDirection: { x: 0, y: 3, z: 0 },
      normal: { x: 0, y: 0, z: 3 },
    };
    const recovered = unadjustConnectorFrame(scaled, { axis: 'z', angle: 0 }, [0, 0, 2]);
    expect(recovered.xDirection).toEqual({ x: 1, y: 0, z: 0 });
    // The offset walks the UNIT axis — a 3× normal must not walk 6mm.
    expect(recovered.origin.z).toBeCloseTo(-2, 10);
  });
});
