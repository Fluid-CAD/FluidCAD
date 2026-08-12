import { Scene } from "./scene.js";
import { Part } from "../features/part.js";
import { Connector } from "../features/connector.js";
import { SourceLocation } from "../common/scene-object.js";

export type Vec3 = { x: number; y: number; z: number };
export type Quat = { x: number; y: number; z: number; w: number };

export type AssemblyInstance = {
  instanceId: string;
  part: Part;
  position: Vec3;
  quaternion: Quat;
  grounded: boolean;
  name: string;
  sourceLocation?: SourceLocation;
};

export type MateType =
  | 'fastened'
  | 'revolute'
  | 'slider'
  | 'cylindrical'
  | 'planar'
  | 'parallel'
  | 'pin-slot';

/**
 * Live mate record. `connectorA/B.connector` is a live SceneObject
 * reference, not a snapshotted id. SceneCompare may rewrite a Connector's
 * id during scene-diff to inherit the prior render's id; reading
 * `connector.id` at serialize time picks up that rewrite, while a
 * snapshotted id taken at mate() call time would point at the
 * fresh-UUID value before the inherit. Mirrors how `AssemblyInstance`
 * keeps a live `part: Part` ref and reads `part.id` live.
 */
export type AssemblyMate = {
  mateId: string;
  type: MateType;
  connectorA: { instanceId: string; connector: Connector };
  connectorB: { instanceId: string; connector: Connector };
  options?: { rotate?: number; flip?: boolean; offset?: [number, number, number]; limits?: [number, number] };
  sourceLocation?: SourceLocation;
};

export type SerializedInstance = {
  instanceId: string;
  partId: string;
  partName: string;
  position: Vec3;
  quaternion: Quat;
  grounded: boolean;
  name: string;
  sourceLocation?: SourceLocation;
};

export type SerializedMate = {
  mateId: string;
  type: MateType;
  connectorA: { instanceId: string; connectorId: string };
  connectorB: { instanceId: string; connectorId: string };
  status: 'satisfied' | 'redundant' | 'inconsistent';
  options?: { rotate?: number; flip?: boolean; offset?: [number, number, number]; limits?: [number, number] };
  sourceLocation?: SourceLocation;
};

export class AssemblyScene extends Scene {
  private _instances: AssemblyInstance[] = [];
  private _mates: AssemblyMate[] = [];

  addInstance(instance: AssemblyInstance): void {
    this._instances.push(instance);
  }

  addMate(mate: AssemblyMate): void {
    this._mates.push(mate);
  }

  getInstances(): AssemblyInstance[] {
    return this._instances;
  }

  getInstance(instanceId: string): AssemblyInstance | null {
    return this._instances.find(i => i.instanceId === instanceId) ?? null;
  }

  /**
   * Assembly-scoped connectors — `connector()` statements at the top level of
   * the assembly file, each bound to one instance. Part-owned connectors
   * (children of a part container) are not included. Pass an instanceId to
   * narrow to one instance's set.
   */
  getInstanceConnectors(instanceId?: string): Connector[] {
    return this.getAllSceneObjects().filter((obj): obj is Connector =>
      obj instanceof Connector
      && obj.boundInstanceId !== undefined
      && (instanceId === undefined || obj.boundInstanceId === instanceId),
    );
  }

  getMates(): AssemblyMate[] {
    return this._mates;
  }

  ground(instanceId: string): void {
    for (const inst of this._instances) {
      if (inst.instanceId === instanceId) {
        inst.grounded = true;
      }
    }
  }

  getSerializedInstances(): SerializedInstance[] {
    return this._instances.map(inst => ({
      instanceId: inst.instanceId,
      // Read live from inst.part — SceneCompare.inheritIdentityFrom may
      // rewrite Part.id after the AssemblyInstance was created, so any
      // value snapshotted at insert() time would be stale by render time.
      partId: inst.part.id,
      partName: inst.part.partName,
      position: inst.position,
      quaternion: inst.quaternion,
      grounded: inst.grounded,
      name: inst.name,
      sourceLocation: inst.sourceLocation,
    }));
  }

  getSerializedMates(): SerializedMate[] {
    // Read connector ids live — SceneCompare.inheritIdentityFrom may have
    // rewritten them after the mate was added during parse.
    return this._mates.map(mate => ({
      mateId: mate.mateId,
      type: mate.type,
      connectorA: {
        instanceId: mate.connectorA.instanceId,
        connectorId: mate.connectorA.connector.id,
      },
      connectorB: {
        instanceId: mate.connectorB.instanceId,
        connectorId: mate.connectorB.connector.id,
      },
      // Parse-time placeholder: the UI solver evaluates real mate
      // health per solve (SolverOutput.failed) and overrides this live
      // via matesWithStatus — the server never re-checks it.
      status: 'satisfied',
      options: mate.options,
      sourceLocation: mate.sourceLocation,
    }));
  }
}
