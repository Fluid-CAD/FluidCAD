import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  JOINT_SPECS,
  defaultParams,
  extract,
  isSatisfied,
  mergeParams,
  observedFlip,
  pose,
  residual,
  type JointParams,
  type MateOptions,
  type MateType,
} from '../src/solver/joint-model';
import type { BodyState, ConnectorState } from '../src/solver';

// Round-trip properties of the generic joint model, exercised at
// deliberately non-trivial poses and connector frames:
//   extract(pose(params)) == params   (free params; fixed echo options)
//   residual(pose(params)) == 0
//   isSatisfied(pose(params)) == true

// A driver with a rotated/translated body pose and an off-origin,
// non-axis-aligned connector frame.
function makeDriver(): { body: BodyState; conn: ConnectorState } {
  const conn: ConnectorState = {
    connectorId: 'd',
    localOrigin: new Vector3(1, 2, 3),
    localXDirection: new Vector3(0, 0, 1),
    localNormal: new Vector3(0, 1, 0),
  };
  const body: BodyState = {
    instanceId: 'driver',
    position: new Vector3(10, 20, 30),
    quaternion: new Quaternion().setFromAxisAngle(
      new Vector3(1, 1, 0).normalize(), (40 * Math.PI) / 180,
    ),
    grounded: true,
    connectors: [conn],
  };
  return { body, conn };
}

// Follower connector with its own non-trivial local frame.
function makeFollowerConn(): ConnectorState {
  return {
    connectorId: 'f',
    localOrigin: new Vector3(5, -2, 1),
    localXDirection: new Vector3(0, 1, 0),
    localNormal: new Vector3(1, 0, 0),
  };
}

// Materialize the follower at the pose the model produces for `params`.
function makeFollower(
  driver: BodyState,
  driverConn: ConnectorState,
  followerConn: ConnectorState,
  options: MateOptions,
  params: JointParams,
): BodyState {
  const target = pose(driver, driverConn, followerConn, options, params);
  return {
    instanceId: 'follower',
    position: target.position,
    quaternion: target.quaternion,
    grounded: false,
    connectors: [followerConn],
  };
}

type Case = {
  type: MateType;
  options: MateOptions;
  /** The free-param values to realize (fixed entries must echo options). */
  params: JointParams;
  residualDim: number;
};

const CASES: Case[] = [
  {
    type: 'fastened',
    options: { rotate: 30, offset: [2, 3, 4] },
    params: { rotZ: 30, slideZ: 4, x: 2, y: 3 },
    residualDim: 6,
  },
  {
    type: 'revolute',
    options: { offset: [1, 2, 3] },
    params: { rotZ: 47.5, slideZ: 3, x: 1, y: 2 },
    residualDim: 5,
  },
  {
    type: 'slider',
    options: { rotate: 20 },
    params: { rotZ: 20, slideZ: 12.34, x: 0, y: 0 },
    residualDim: 5,
  },
  {
    type: 'cylindrical',
    options: {},
    params: { rotZ: -72, slideZ: 8.5, x: 0, y: 0 },
    residualDim: 4,
  },
  {
    type: 'planar',
    options: { offset: [0, 0, 5] },
    params: { rotZ: 33, slideZ: 5, x: 3.2, y: -1.7 },
    residualDim: 3,
  },
];

describe('joint-model — extract/pose/residual round trips', () => {
  for (const c of CASES) {
    describe(c.type, () => {
      const { body: driver, conn: driverConn } = makeDriver();
      const followerConn = makeFollowerConn();
      const follower = makeFollower(driver, driverConn, followerConn, c.options, c.params);
      const spec = JOINT_SPECS[c.type]!;

      it('extract(pose(params)) round-trips the params', () => {
        const measured = extract(driver, driverConn, follower, followerConn);
        const merged = mergeParams(spec, measured, c.options);
        expect(merged.rotZ).toBeCloseTo(c.params.rotZ, 9);
        expect(merged.slideZ).toBeCloseTo(c.params.slideZ, 9);
        expect(merged.x).toBeCloseTo(c.params.x, 9);
        expect(merged.y).toBeCloseTo(c.params.y, 9);
      });

      it('residual(pose(params)) is zero at the right dimension', () => {
        const r = residual(c.type, driver, driverConn, follower, followerConn, c.options);
        expect(r).toHaveLength(c.residualDim);
        for (const v of r) {
          expect(Math.abs(v)).toBeLessThan(1e-9);
        }
      });

      it('isSatisfied(pose(params)) is true', () => {
        expect(isSatisfied(c.type, driver, driverConn, follower, followerConn, c.options))
          .toBe(true);
      });

      it('default chirality is face-to-face (observedFlip false)', () => {
        expect(observedFlip(driver, driverConn, follower, followerConn)).toBe(false);
      });
    });
  }

  it('flip chirality: pose lands on the Z-along branch and still round-trips', () => {
    const { body: driver, conn: driverConn } = makeDriver();
    const followerConn = makeFollowerConn();
    const options: MateOptions = { flip: true };
    const params: JointParams = { rotZ: 25, slideZ: 0, x: 0, y: 0 };
    const follower = makeFollower(driver, driverConn, followerConn, options, params);

    expect(observedFlip(driver, driverConn, follower, followerConn)).toBe(true);
    const measured = extract(driver, driverConn, follower, followerConn);
    expect(measured.rotZ).toBeCloseTo(25, 9);
    // The freeRotZ residual accepts both chirality branches.
    const r = residual('revolute', driver, driverConn, follower, followerConn, options);
    for (const v of r) {
      expect(Math.abs(v)).toBeLessThan(1e-9);
    }
    expect(isSatisfied('revolute', driver, driverConn, follower, followerConn, options))
      .toBe(true);
  });

  it('off-manifold pose: residual is non-zero and isSatisfied false', () => {
    const { body: driver, conn: driverConn } = makeDriver();
    const followerConn = makeFollowerConn();
    const options: MateOptions = {};
    const follower = makeFollower(
      driver, driverConn, followerConn, options,
      { rotZ: 0, slideZ: 0, x: 0, y: 0 },
    );
    // Nudge the follower off the revolute manifold (pure translation
    // violates the coincident-origin constraint).
    follower.position.add(new Vector3(0.5, -0.25, 0.75));
    const r = residual('revolute', driver, driverConn, follower, followerConn, options);
    const norm = Math.sqrt(r.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeGreaterThan(0.5);
    expect(isSatisfied('revolute', driver, driverConn, follower, followerConn, options))
      .toBe(false);
  });

  it('defaultParams echoes the option-fixed values', () => {
    expect(defaultParams({ rotate: 15, offset: [1, 2, 3] }))
      .toEqual({ rotZ: 15, slideZ: 3, x: 1, y: 2 });
    expect(defaultParams({})).toEqual({ rotZ: 0, slideZ: 0, x: 0, y: 0 });
  });
});
