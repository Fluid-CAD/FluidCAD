// The serialized assembly a render hands to the UI.

export type SerializedAssembly = {
  instances: Array<{
    instanceId: string;
    partId: string;
    partName: string;
    position: { x: number; y: number; z: number };
    quaternion: { x: number; y: number; z: number; w: number };
    /** EFFECTIVE grounding (scoped-grounding rule already applied by the engine). */
    grounded: boolean;
    /** Owning scope path; "" for root-scope instances. Engines predating sub-assemblies omit it. */
    owner?: string;
    name: string;
    /** Resolved parameter values of the instance's template variant — absent pre-parameters engines. */
    paramValues?: Record<string, string | number | boolean | (string | number)[]>;
    sourceLocation?: { filePath: string; line: number; column: number };
    /** Present on a replica produced by a `replicate()` statement. */
    replica?: { of: string; statement: string; row: number };
  }>;
  /** Sub-assembly occurrences — absent on engines predating assembly() definitions. */
  occurrences?: Array<{
    occurrenceId: string;
    assemblyName: string;
    name: string;
    parentPath: string;
    position: { x: number; y: number; z: number };
    quaternion: { x: number; y: number; z: number; w: number };
    grounded: boolean;
    groundConnected: boolean;
    /** The definition's `param()` interface — absent pre-parameters engines. */
    params?: Record<string, unknown>[];
    /** Resolved parameter values of this occurrence's run. */
    paramValues?: Record<string, string | number | boolean | (string | number)[]>;
    /**
     * Handles the callback returned, keyed by return-object path — how a mate
     * in the inserting file references this occurrence's contents
     * (`<binding>.parts.<path...>`). Absent on engines predating exports.
     */
    exports?: Array<{ path: string[]; instanceId?: string; occurrenceId?: string }>;
    sourceLocation?: { filePath: string; line: number; column: number };
    /** Present on a replica produced by a `replicate()` statement. */
    replica?: { of: string; statement: string; row: number };
  }>;
  mates: Array<{
    mateId: string;
    type: 'fastened' | 'revolute' | 'slider' | 'cylindrical' | 'planar' | 'parallel' | 'pin-slot' | 'tangent';
    connectorA?: { instanceId: string; connectorId: string };
    connectorB?: { instanceId: string; connectorId: string };
    geometryA?: { instanceId: string; exposeName: string };
    geometryB?: { instanceId: string; exposeName: string };
    frameA?: { connectorId: string };
    frameB?: { connectorId: string };
    status: 'satisfied' | 'redundant' | 'inconsistent';
    options?: { rotate?: number; flip?: boolean; offset?: [number, number, number]; limits?: [number, number]; propagate?: boolean };
    sourceLocation?: { filePath: string; line: number; column: number };
    /** Present on a replicated mate produced by a `replicate()` statement. */
    replica?: { of: string; statement: string; row: number };
  }>;
  /** Assembly-level connectors — absent on engines predating them. */
  connectors?: Array<{
    connectorId: string;
    name: string;
    owner: string;
    origin: { x: number; y: number; z: number };
    xDirection: { x: number; y: number; z: number };
    yDirection: { x: number; y: number; z: number };
    normal: { x: number; y: number; z: number };
    sourceLocation?: { filePath: string; line: number; column: number };
  }>;
  /** `replicate()` statements — absent on engines predating them. */
  replicates?: Array<{
    replicateId: string;
    owner: string;
    seed: { instanceId?: string; occurrenceId?: string };
    targets: Array<
      | { kind: 'connector'; instanceId: string; connectorId: string }
      | { kind: 'frame'; connectorId: string }
      | { kind: 'geometry'; instanceId: string; exposeName: string }
    >;
    rows: Array<Array<
      | { kind: 'connector'; instanceId: string; connectorId: string }
      | { kind: 'frame'; connectorId: string }
      | { kind: 'geometry'; instanceId: string; exposeName: string }
    >>;
    produced: Array<{ instanceId?: string; occurrenceId?: string }>;
    sourceLocation?: { filePath: string; line: number; column: number };
  }>;
};
