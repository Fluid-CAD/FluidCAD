import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import {
  applyAssemblyConnector, getAssemblyConnectorExpressions, getScopeVariables, listAssemblyConnectorNames,
  type InstanceAxisExprs,
} from '../../api';
import type { SerializedAssembly, SerializedAssemblyConnector } from '../../types';
import type { Viewer } from '../../viewer';
import { resolveExpressionValue, type VariableInfo } from '../../ui/expression-core';
import { ConnectorGhostOverlay } from '../create-feature/connector-ghost';
import type { ConnectorFrameData } from '../../meshes/containers/connector-mesh';
import { AssemblyConnectorPanel, type AxisValue, type ConnectorPanelValues } from './connector-panel';

type Triple = [number, number, number];

type EditTarget = {
  filePath: string;
  sourceLine: number;
  name: string;
  /** Whether the statement's rotate chain is canonical (rewritable). */
  rotationEditable: boolean;
};

/**
 * The assembly-connector tool: the toolbar's Connector button opens the
 * dialog in create mode (name prefilled with the first free `c1`-style
 * default, a translucent triad ghost at the origin tracking every edit);
 * Apply writes `const <name> = connector('<name>', [x, y, z])<rotates>;`
 * at the assembly's top level. The rail's connector rows and the mate
 * dialog's chip pen open the same dialog in edit mode, seeded from the
 * rendered frame and the statement's exact expression texts, and Apply
 * rewrites the statement in place.
 *
 * Rotation is intrinsic XYZ (each `.rotate()` turns about the frame's
 * current own axis, chain order x→y→z) — three.js `Euler` order 'XYZ'.
 */
export class AssemblyConnectorService {
  private panel: AssemblyConnectorPanel;
  private ghost: ConnectorGhostOverlay;
  private armed = false;
  private applying = false;
  private editTarget: EditTarget | null = null;
  private variables: VariableInfo[] = [];
  /** Numeric fallbacks for expression fields the client can't evaluate. */
  private seedPosition: Triple = [0, 0, 0];
  private seedRotation: Triple = [0, 0, 0];

  constructor(
    container: HTMLElement,
    private viewer: Viewer,
    private hooks: {
      getAssembly: () => SerializedAssembly | null;
      getCurrentFile: () => string | null;
      onEnter?: () => void;
      onExit?: () => void;
    },
  ) {
    this.panel = new AssemblyConnectorPanel(container);
    this.ghost = new ConnectorGhostOverlay(viewer);
    this.panel.onApply = () => void this.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.refreshPreview();
    };
  }

  get isActive(): boolean {
    return this.armed;
  }

  /** The toolbar button: open in create mode (a second click closes). */
  async enter(): Promise<void> {
    if (this.armed && this.editTarget === null) {
      this.exit();
      return;
    }
    const filePath = this.hooks.getCurrentFile();
    if (!filePath) {
      return;
    }
    this.editTarget = null;
    this.open();
    const [names, variables] = await Promise.all([
      listAssemblyConnectorNames(filePath),
      getScopeVariables(null),
    ]);
    if (!this.armed || this.editTarget !== null) {
      return;
    }
    this.variables = variables;
    this.panel.setVariables(variables);
    this.seedPosition = [0, 0, 0];
    this.seedRotation = [0, 0, 0];
    this.panel.show({
      title: 'Assembly connector',
      name: freeName(names),
      position: [0, 0, 0],
      rotation: [0, 0, 0],
    });
    this.refreshPreview();
  }

  /**
   * Edit an existing assembly connector: seed numerics from the rendered
   * frame (always available), then overlay the statement's exact texts so
   * expressions survive; a chain the writer can't canonicalize blocks the
   * rotation row and commits position only.
   */
  async edit(connector: SerializedAssemblyConnector): Promise<void> {
    if (!connector.sourceLocation) {
      return;
    }
    const target: EditTarget = {
      filePath: connector.sourceLocation.filePath,
      sourceLine: connector.sourceLocation.line,
      name: connector.name,
      rotationEditable: true,
    };
    this.editTarget = target;
    this.open();
    const euler = frameToEuler(connector);
    const position: Triple = [connector.origin.x, connector.origin.y, connector.origin.z];
    const [expressions, variables] = await Promise.all([
      getAssemblyConnectorExpressions(connector.sourceLocation),
      getScopeVariables(connector.sourceLocation.line),
    ]);
    if (!this.armed || this.editTarget !== target) {
      return;
    }
    this.variables = variables;
    this.panel.setVariables(variables);
    this.seedPosition = position;
    this.seedRotation = euler;
    target.rotationEditable = expressions?.rotate !== null && expressions?.rotate !== undefined;
    const positionSeed = position.map((n, i) => {
      const text = expressions?.position?.[AXIS_KEYS[i]];
      return text !== null && text !== undefined ? text : round(n);
    }) as [number | string, number | string, number | string];
    const rotationSeed = target.rotationEditable
      ? euler.map((n, i) => {
        const text = expressions?.rotate?.[AXIS_KEYS[i]];
        return text !== null && text !== undefined ? text : round(n);
      }) as [number | string, number | string, number | string]
      : null;
    this.panel.show({
      title: `Edit connector · ${connector.name}`,
      name: connector.name,
      position: positionSeed,
      rotation: rotationSeed,
      note: rotationSeed === null
        ? 'This connector chains calls the dialog can\'t rewrite (an .offset() or a non-canonical rotation) — edit its rotation in the source; position edits still apply.'
        : undefined,
    });
    this.refreshPreview();
  }

  exit(): void {
    if (!this.armed) {
      return;
    }
    this.armed = false;
    this.editTarget = null;
    this.ghost.clear();
    this.panel.hide();
    this.hooks.onExit?.();
  }

  /** A render landed: a part scene closes the dialog; an edit whose statement vanished too. */
  handleSceneRendered(sceneKind: 'part' | 'assembly'): void {
    if (!this.armed) {
      return;
    }
    if (sceneKind !== 'assembly') {
      this.exit();
      return;
    }
    if (this.editTarget) {
      const target = this.editTarget;
      const fresh = this.hooks.getAssembly()?.connectors?.find(c =>
        c.sourceLocation?.filePath === target.filePath && c.sourceLocation.line === target.sourceLine);
      if (!fresh) {
        this.exit();
      }
    }
  }

  private open(): void {
    if (!this.armed) {
      this.armed = true;
      this.hooks.onEnter?.();
    }
    this.panel.setMessage(null);
    this.panel.setApplyEnabled(true);
  }

  /** The dialog's numbers → the triad ghost and the statement preview. */
  private refreshPreview(): void {
    if (!this.armed) {
      return;
    }
    const values = this.panel.values();
    if ('error' in values) {
      this.ghost.clearPreview();
      this.panel.setPreview(null);
      this.panel.setApplyEnabled(false);
      return;
    }
    const position = this.numeric(values.position, this.seedPosition);
    const rotation = values.rotation ? this.numeric(values.rotation, this.seedRotation) : this.seedRotation;
    this.ghost.showPreview(eulerToFrame(position, rotation));
    this.panel.setPreview(renderStatement(values, this.editTarget));
    this.panel.setApplyEnabled(!this.applying);
  }

  private numeric(values: [AxisValue, AxisValue, AxisValue], fallback: Triple): Triple {
    return values.map((v, i) => {
      if (typeof v.value === 'number') {
        return v.value;
      }
      return resolveExpressionValue(v.value, this.variables, v.newVariable ?? null) ?? fallback[i];
    }) as Triple;
  }

  private async apply(): Promise<void> {
    if (!this.armed || this.applying) {
      return;
    }
    const values = this.panel.values();
    if ('error' in values) {
      this.panel.setMessage(values.error);
      return;
    }
    const filePath = this.editTarget?.filePath ?? this.hooks.getCurrentFile();
    if (!filePath) {
      this.panel.setMessage('No assembly file is open.');
      return;
    }
    const position = this.numeric(values.position, this.seedPosition);
    const positionExprs = exprs(values.position);
    const rotateXYZ = values.rotation ? this.numeric(values.rotation, this.seedRotation) : null;
    const rotateExprs = values.rotation ? exprs(values.rotation) : null;
    this.applying = true;
    this.panel.setApplyEnabled(false);
    try {
      const result = await applyAssemblyConnector(filePath, {
        ...(this.editTarget
          ? { edit: { sourceLine: this.editTarget.sourceLine, name: values.name } }
          : { create: { name: values.name } }),
        position,
        rotateXYZ,
        positionExprs,
        rotateExprs,
        newVariables: values.newVariables,
      });
      if (!result.success) {
        this.panel.setMessage(result.reason ?? (this.editTarget ? 'Could not update the connector.' : 'Could not add the connector.'));
        this.panel.setApplyEnabled(true);
        return;
      }
      // The re-render shows the committed connector; editor undo is the rollback.
      this.exit();
    } finally {
      this.applying = false;
    }
  }
}

const AXIS_KEYS = ['x', 'y', 'z'] as const;

function round(n: number): number {
  return +n.toFixed(6);
}

/** Per-axis source text for the writer: expressions verbatim, numerics as null. */
function exprs(values: [AxisValue, AxisValue, AxisValue]): InstanceAxisExprs {
  return values.map(v => (typeof v.value === 'string' ? v.value : null)) as InstanceAxisExprs;
}

/** The first `c1`, `c2`, … not already declared. */
export function freeName(taken: ReadonlyArray<string>): string {
  const set = new Set(taken);
  for (let n = 1; ; n++) {
    const candidate = `c${n}`;
    if (!set.has(candidate)) {
      return candidate;
    }
  }
}

/**
 * The frame a position + intrinsic XYZ rotation (degrees) produces: the
 * kernel applies `.rotate('x', a)` then `.rotate('y', b)` about the
 * frame's CURRENT own axis, then `.rotate('z', c)` — R = Rx·Ry·Rz, which
 * is three.js Euler order 'XYZ'.
 */
export function eulerToFrame(position: Triple, rotationDeg: Triple): ConnectorFrameData {
  const q = new Quaternion().setFromEuler(new Euler(
    rotationDeg[0] * Math.PI / 180,
    rotationDeg[1] * Math.PI / 180,
    rotationDeg[2] * Math.PI / 180,
    'XYZ',
  ));
  const axis = (x: number, y: number, z: number) => {
    const v = new Vector3(x, y, z).applyQuaternion(q);
    return { x: v.x, y: v.y, z: v.z };
  };
  return {
    origin: { x: position[0], y: position[1], z: position[2] },
    xDirection: axis(1, 0, 0),
    yDirection: axis(0, 1, 0),
    normal: axis(0, 0, 1),
  };
}

/** The intrinsic XYZ degrees that reproduce a rendered frame's basis. */
export function frameToEuler(frame: {
  xDirection: { x: number; y: number; z: number };
  yDirection: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
}): Triple {
  const m = new Matrix4().makeBasis(
    new Vector3(frame.xDirection.x, frame.xDirection.y, frame.xDirection.z),
    new Vector3(frame.yDirection.x, frame.yDirection.y, frame.yDirection.z),
    new Vector3(frame.normal.x, frame.normal.y, frame.normal.z),
  );
  const e = new Euler().setFromRotationMatrix(m, 'XYZ');
  const deg = (r: number) => {
    const d = round(r * 180 / Math.PI);
    return Object.is(d, -0) ? 0 : d;
  };
  return [deg(e.x), deg(e.y), deg(e.z)];
}

/** The statement the dialog would write — display only; the server writes truth. */
function renderStatement(values: ConnectorPanelValues, target: EditTarget | null): string {
  const text = (v: AxisValue) => (typeof v.value === 'number' ? String(round(v.value)) : v.value);
  let chain = `connector('${values.name}', [${values.position.map(text).join(', ')}])`;
  if (values.rotation) {
    values.rotation.forEach((v, i) => {
      if (typeof v.value === 'number' ? v.value !== 0 : true) {
        chain += `.rotate('${AXIS_KEYS[i]}', ${text(v)})`;
      }
    });
  } else {
    chain += '…';
  }
  const binding = target ? target.name : values.name;
  return `const ${binding} = ${chain};`;
}
