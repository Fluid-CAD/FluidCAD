import { Box3, Camera, Group, Object3D, Plane, Quaternion, Raycaster, Vector2, Vector3, WebGLRenderer } from 'three';
import { ConnectorData, ExposedData, SceneObjectRender, SerializedAssembly, SerializedAssemblyInstance, SerializedAssemblyMate } from '../types';
import { buildObjectMesh } from '../meshes/mesh-factory';
import { buildConnectorGizmo } from '../meshes/containers/connector-mesh';
import { onThemeChange } from './theme-colors';
import {
  ORIGIN_BODY_ID,
  ORIGIN_CONNECTOR_ID,
  Solver,
  buildMateGraph,
  isInstanceFullyLocked,
  makeOriginBody,
  mateReadoutValue,
  matesReferenceOrigin,
  originConnectorRef,
} from '../solver';
import type { BodyState, ConnectorState, ContactState, MateReadout, MateRecord, SolverInput, SolverOutput, TreeEdge } from '../solver';

const DRAG_THRESHOLD_PX = 4;
/** Screen radius a click may miss a connector-gizmo origin by and still pick it. */
const CONNECTOR_PICK_RADIUS_PX = 22;

/**
 * Gizmo opacity while the mate dialog's connector picker is armed: every
 * connector shows translucent so the full pickable set is visible at a
 * glance; the hovered and already-picked ones render fully opaque.
 */
const MATE_PICKING_GIZMO_OPACITY = 0.4;
/** Hover feedback while picking: the gizmo grows by this factor. */
const CONNECTOR_HIGHLIGHT_SCALE = 1.35;

type InstanceState = {
  data: SerializedAssemblyInstance;
  group: Group;
  connectors: ConnectorState[];
  /** Classified exposures of the instance's part — tangent-mate geometry. */
  contacts: ContactState[];
};

export type InstanceDragReleaseHandler = (
  instanceId: string,
  position: { x: number; y: number; z: number },
) => void;

export type InstanceDragClaimHandler = () => void;

export type SolverUpdateHandler = (output: SolverOutput) => void;

export type DragValueHandler = (readout: MateReadout | null) => void;

/**
 * The slider/revolute tree edge incident to the dragged instance, resolved
 * once at drag-start (mate topology is fixed for the gesture). Holds the
 * driver/follower ids + their body-local connector frames so the live value
 * can be recomputed from the solved poses each frame.
 */
type ReadoutEdge = {
  mate: MateRecord;
  driverId: string;
  driverConn: ConnectorState;
  followerId: string;
  followerConn: ConnectorState;
};

export class AssemblyController {
  private container = new Group();
  private instances = new Map<string, InstanceState>();
  private partTemplates = new Map<string, SceneObjectRender>();
  private allObjects: SceneObjectRender[] = [];
  private mates: MateRecord[] = [];
  private dragReleaseHandler: InstanceDragReleaseHandler | null = null;
  private dragClaimHandler: InstanceDragClaimHandler | null = null;
  private solverUpdateHandler: SolverUpdateHandler | null = null;
  private dragValueHandler: DragValueHandler | null = null;
  private solver = new Solver();
  /**
   * Instance the cursor is on. Connectors are hidden by default in assembly
   * mode; hover reveals the ones on this instance only while a mate dialog
   * has picking armed ({@link matePicking}) — with no dialog open hover
   * shows nothing, and the id is just kept current so arming reveals the
   * part already under the cursor. Tracking the id (not a Group ref) keeps
   * it valid across diff updates that may replace the underlying group.
   */
  private hoveredInstanceId: string | null = null;
  /**
   * Connectors that should stay visible regardless of hover state — set
   * by {@link highlightMate} so the two connectors participating in the
   * selected joint remain visible after the cursor leaves their instances.
   * Cleared by {@link clearHighlight}.
   */
  private mateRevealedConnectors = new Set<Object3D>();
  /**
   * Connectors currently filling the mate dialog's slots, keyed per
   * (instance, connector) pair ({@link pickedSlotKey}) — connector ids are
   * part-scoped and shared by every instance of the part, so a bare-id set
   * would light the connector up on all of the part's siblings. Picked
   * slots render opaque while picking (the rest stay translucent) and stay
   * pinned visible in hover-reveal mode. Scene ids, refreshed by the
   * service on every render re-resolve.
   */
  private matePickedSlotKeys = new Set<string>();
  /**
   * A mate dialog's connector slot is armed: connectors are screen-pickable
   * ({@link pickConnectorAt}) and pointerdown never claims a drag — a click
   * means "pick", not "move". Set via {@link setMatePicking}.
   */
  private matePicking = false;
  /**
   * How armed picking reveals gizmos: `true` (create mode) shows every
   * connector; `false` (edit mode) reveals on hover, plus the slot-filling
   * connectors pinned so the mate's current endpoints stay in view.
   * Meaningful only while {@link matePicking}.
   */
  private matePickingRevealAll = true;
  /**
   * Connector hovered while {@link matePicking} — its gizmo renders enlarged
   * (see {@link applyConnectorHighlight}). Tracked as an id so it survives
   * diff updates that replace the underlying meshes.
   */
  private highlightedConnectorId: string | null = null;
  /**
   * Set on pointerup for the gesture that just ended (or `null` once
   * consumed / between gestures). Read via {@link consumeRecentDrag}: if
   * non-null, the viewer's mouseup-as-click handler suppresses the
   * face-selection click and uses the instance id to suppress hover on the
   * just-dropped part until the cursor leaves it. `moved` distinguishes a
   * real drag from a plain click on the part — every pointerdown on a
   * draggable instance is claimed here (so no face pick ever fires for
   * one), and a no-move claim is the viewer's only signal that the user
   * *clicked* the part (it becomes an instance selection → transform
   * gizmo). Eagerly cleared at the start of the next pointerdown so it can
   * never leak across gestures if a mouseup is missed.
   */
  private postDragSuppress: { instanceId: string; moved: boolean } | null = null;

  /**
   * A programmatic drag claimed by the transform gizmo: the driver feeds
   * axis-constrained targets through the same solver loop the pointer drag
   * uses. Mutually exclusive with {@link dragState}; participates in the
   * same isDragging / update()-skip guards so a mid-drag render doesn't
   * snap the manipulated part back.
   */
  private externalDrag: { instanceId: string } | null = null;

  /**
   * The mate dialog's live preview: a not-yet-committed mate solved alongside
   * the real ones so the parts pull together while the dialog is still open.
   * Never persisted; cleared (with poses restored from the serialized data)
   * when the dialog closes or its picks change.
   */
  private provisionalMate: MateRecord | null = null;

  private dragState: {
    instanceId: string;
    plane: Plane;
    /** Vector from grab-point world position to body origin, captured at
     *  drag-start. Free-body translation uses this to convert cursor world
     *  → body origin target each frame. */
    grabOffset: Vector3;
    /** Grab point in the body's *local* frame (at drag-start). Combined
     *  with the body's live pose this gives the grab point's current world
     *  position, which is what mate-aware drag handlers need to compute
     *  the rotation that makes the grab point track the cursor. */
    grabLocal: Vector3;
    moved: boolean;
    downX: number;
    downY: number;
    /** Pointer that claimed the gesture — lets {@link cancelPointerGesture}
     *  release the capture taken at pointerdown. */
    pointerId: number;
    /** Last solved cursor position, in client coords. Pointer events
     *  often arrive faster than the cursor visibly moves (high-rate
     *  mice + browser smoothing); skipping a solve when (clientX,
     *  clientY) is identical to the previous one drops a meaningful
     *  fraction of redundant work without introducing latency, since
     *  the result would be identical. */
    lastSolvedClientX: number;
    lastSolvedClientY: number;
    /** The slider/revolute joint being manipulated, resolved at drag-start;
     *  null when the dragged body isn't on one (no live value shown). */
    readoutEdge: ReadoutEdge | null;
  } | null = null;

  /**
   * The world-origin triad — a connector-style gizmo at (0,0,0) that mate
   * dialogs can pick as a side (`origin()` in the source). Lives outside
   * the instance map: it is scene furniture, not an instance. Visible only
   * while a mate dialog is picking or a joints-panel selection pinned it.
   */
  private originGizmo: Group;
  /** An origin-mate joints-panel selection keeps the triad visible. */
  private originPinned = false;

  constructor(
    private renderer: WebGLRenderer,
    private camera: Camera,
    private requestRender: () => void,
    private createPickingRaycaster: (ndcX: number, ndcY: number) => Raycaster,
  ) {
    this.container.name = 'assemblyContainer';
    this.originGizmo = this.buildOriginGizmo();
    this.container.add(this.originGizmo);
    this.attachPointerHandlers();
    // Face/edge colors are baked into materials at build time and the
    // viewer's theme-change rebuild deliberately skips assembly mode, so
    // the controller re-meshes its own instance groups. Subscribed for the
    // controller's whole life — the viewer keeps one instance per session.
    onThemeChange(() => this.rebuildInstanceMeshes());
  }

  /**
   * Re-mesh every instance with the current theme colors. Live pose is
   * copied from the old group (the solver may have moved it off the
   * serialized position), along with per-instance visibility; connector
   * reveal/highlight state is re-asserted the same way {@link update} does
   * after a rebuild. Runs even while the container is detached (a part
   * file on screen) so switching back to the assembly shows fresh colors.
   */
  private rebuildInstanceMeshes(): void {
    if (this.instances.size === 0) {
      return;
    }
    for (const state of this.instances.values()) {
      const group = this.buildInstanceGroup(state.data);
      if (!group) {
        continue;
      }
      group.position.copy(state.group.position);
      group.quaternion.copy(state.group.quaternion);
      group.visible = state.group.visible;
      this.container.remove(state.group);
      this.disposeGroup(state.group);
      state.group = group;
      this.container.add(group);
      this.applyConnectorVisibility(state);
    }
    this.applyConnectorHighlight();
    this.requestRender();
  }

  getContainer(): Group {
    return this.container;
  }

  /**
   * Diff incoming assembly data against current state. The source is the
   * source of truth for poses (phase 03b: drag-release writes `.translate(...)` back
   * into the file), so existing instances are re-synced from the new
   * `inst.position` / `inst.quaternion`. The currently dragged instance is
   * skipped to avoid snapping it back mid-drag — the next render after
   * pointerup will catch up. Removed instances are pruned.
   */
  update(sceneObjects: SceneObjectRender[], assembly: SerializedAssembly): void {
    this.allObjects = sceneObjects;
    this.partTemplates.clear();
    for (const obj of sceneObjects) {
      if (obj.type === 'part' && obj.id) {
        this.partTemplates.set(obj.id, obj);
      }
    }
    this.mates = assembly.mates.map(toMateRecord);

    const incomingIds = new Set(assembly.instances.map(i => i.instanceId));
    for (const [id, state] of this.instances) {
      if (!incomingIds.has(id)) {
        this.container.remove(state.group);
        this.disposeGroup(state.group);
        this.instances.delete(id);
        if (this.hoveredInstanceId === id) {
          this.hoveredInstanceId = null;
        }
      }
    }

    for (const inst of assembly.instances) {
      const connectors = this.collectConnectorStates(inst.partId);
      const contacts = this.collectExposureStates(inst.partId);
      const existing = this.instances.get(inst.instanceId);
      // SceneCompare flips `fromCache` to false on any object it had to
      // rebuild — including when a parameter change shifts a partName (and
      // its whole subtree) into fresh ids. The pose-only fast path below
      // would keep showing the previous mesh, so check the part's subtree
      // and force a rebuild if anything in it was re-built this render.
      const subtreeFresh = this.partSubtreeWasRebuilt(inst.partId);
      const isDragging = this.dragState?.instanceId === inst.instanceId
        || this.externalDrag?.instanceId === inst.instanceId;
      // partId-changed guard: instance ids are counter-based, so commenting
      // out an earlier insert() shifts a later instance onto an id whose
      // existing group was built from a different part. Without this check
      // the fast path below would just patch pose/data and leave the wrong
      // mesh on screen.
      const partChanged = existing !== undefined && existing.data.partId !== inst.partId;
      if (existing && !partChanged && (!subtreeFresh || isDragging)) {
        existing.data = inst;
        existing.connectors = connectors;
        existing.contacts = contacts;
        existing.group.userData.grounded = inst.grounded;
        existing.group.userData.draggable = !inst.grounded;
        if (!isDragging) {
          existing.group.position.set(inst.position.x, inst.position.y, inst.position.z);
          existing.group.quaternion.set(
            inst.quaternion.x, inst.quaternion.y, inst.quaternion.z, inst.quaternion.w,
          );
        }
        continue;
      }
      if (existing) {
        this.container.remove(existing.group);
        this.disposeGroup(existing.group);
        this.instances.delete(inst.instanceId);
      }
      const group = this.buildInstanceGroup(inst);
      if (!group) continue;
      this.instances.set(inst.instanceId, { data: inst, group, connectors, contacts });
      this.container.add(group);
    }

    // Rebuilt groups start with their connectors hidden and unhighlighted;
    // re-assert the reveal/highlight state so a render mid-pick doesn't
    // blank the gizmos the user is aiming at.
    for (const state of this.instances.values()) {
      this.applyConnectorVisibility(state);
    }
    this.applyConnectorHighlight();

    // Kick a no-drag solve so the DOF readout reflects the current state.
    this.runSolverRefresh();
  }

  clear(): void {
    for (const state of this.instances.values()) {
      this.container.remove(state.group);
      this.disposeGroup(state.group);
    }
    this.instances.clear();
    this.partTemplates.clear();
    this.allObjects = [];
    this.mates = [];
    this.hoveredInstanceId = null;
    this.externalDrag = null;
    this.provisionalMate = null;
    this.originPinned = false;
    this.applyOriginVisibility();
  }

  /**
   * Track the instance the cursor is on and — only while a mate dialog has
   * picking armed — reveal its connectors, hiding any previously-revealed
   * set. With no dialog open the id is still recorded (so arming reveals
   * the part already under the cursor) but connectors stay hidden (see
   * {@link buildInstanceGroup}). The viewer's hover handler drives this
   * method based on pick results. Pass `null` to clear.
   */
  setHoveredInstance(instanceId: string | null): void {
    if (this.hoveredInstanceId === instanceId) return;
    const prevId = this.hoveredInstanceId;
    this.hoveredInstanceId = instanceId;
    if (!this.matePicking) {
      return;
    }
    if (prevId) {
      const prev = this.instances.get(prevId);
      if (prev) this.applyConnectorVisibility(prev);
    }
    if (instanceId) {
      const next = this.instances.get(instanceId);
      if (next) this.applyConnectorVisibility(next);
    }
    this.requestRender();
  }

  /**
   * Walk an instance group's connectors and set visibility from the union
   * of the reveal sources, all but the last gated on an armed mate dialog:
   * reveal-all (create mode shows every gizmo), hover (edit mode reveals
   * the instance under the cursor), slot pinning (the connectors filling
   * the dialog's slots), and — dialog or not — pinning by a joints-panel
   * mate selection. With no dialog open plain hover reveals nothing.
   * Single source of truth so hover transitions don't accidentally hide
   * pinned connectors and pin clearing doesn't hide hovered ones.
   */
  private applyConnectorVisibility(state: InstanceState): void {
    const isHovered = this.hoveredInstanceId === state.data.instanceId;
    state.group.traverse((child) => {
      if (!child.userData?.isConnector) return;
      child.visible = (this.matePicking && (
        this.matePickingRevealAll
        || isHovered
        || this.isPickedSlot(state.data.instanceId, child)
      ))
        || this.mateRevealedConnectors.has(child);
      this.applyConnectorOpacity(child, state.data.instanceId);
    });
  }

  /** Whether this connector mesh fills a mate-dialog slot ON this instance. */
  private isPickedSlot(instanceId: string, child: Object3D): boolean {
    const connectorId = child.userData?.connectorId;
    return typeof connectorId === 'string'
      && this.matePickedSlotKeys.has(pickedSlotKey(instanceId, connectorId));
  }

  /**
   * Sync one connector root's gizmo opacity to the picking state: while the
   * mate dialog is picking, everything renders translucent except the
   * hovered and slot-filling connectors; outside picking the gizmos are
   * fully opaque (hover-reveal and pinned mates show the normal triad).
   */
  private applyConnectorOpacity(root: Object3D, instanceId: string): void {
    const emphasized = root.userData?.connectorId === this.highlightedConnectorId
      || this.isPickedSlot(instanceId, root);
    const opacity = !this.matePicking || emphasized ? 1 : MATE_PICKING_GIZMO_OPACITY;
    root.traverse((o) => {
      const mat = (o as { material?: { opacity?: number } }).material;
      if (mat && typeof mat.opacity === 'number') {
        mat.opacity = opacity;
      }
    });
  }

  /** The origin triad: a connector-gizmo group at the world identity frame. */
  private buildOriginGizmo(): Group {
    const group = new Group();
    group.name = 'assemblyOriginGizmo';
    group.userData.isMetaShape = true;
    group.userData.isConnector = true;
    group.userData.connectorId = ORIGIN_CONNECTOR_ID.z;
    group.add(buildConnectorGizmo({
      origin: { x: 0, y: 0, z: 0 },
      xDirection: { x: 1, y: 0, z: 0 },
      yDirection: { x: 0, y: 1, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
    }, this.camera));
    group.visible = false;
    return group;
  }

  /**
   * The origin triad shows while a mate dialog is picking (any mode — it
   * is one gizmo, and edit dialogs need it pickable too) or while a
   * joints-panel selection of an origin mate pins it.
   */
  private applyOriginVisibility(): void {
    this.originGizmo.visible = this.matePicking || this.originPinned;
    this.applyConnectorOpacity(this.originGizmo, ORIGIN_BODY_ID);
  }

  /**
   * True if any SceneObjectRender in `partId`'s subtree has `fromCache: false`
   * — i.e. the lib-side SceneCompare had to rebuild it this render. The
   * partTemplate itself is included in the walk so a partName change (which
   * breaks compare at the part) also counts.
   */
  private partSubtreeWasRebuilt(partId: string): boolean {
    const childrenByParent = new Map<string, SceneObjectRender[]>();
    const objById = new Map<string, SceneObjectRender>();
    for (const obj of this.allObjects) {
      if (obj.id) objById.set(obj.id, obj);
      if (!obj.parentId) continue;
      const list = childrenByParent.get(obj.parentId);
      if (list) list.push(obj);
      else childrenByParent.set(obj.parentId, [obj]);
    }
    const stack: string[] = [partId];
    const visited = new Set<string>();
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const obj = objById.get(id);
      if (obj && !obj.fromCache) return true;
      const children = childrenByParent.get(id);
      if (children) {
        for (const c of children) {
          if (c.id) stack.push(c.id);
        }
      }
    }
    return false;
  }

  /**
   * The connector frames one instance carries: the part's own connectors,
   * shared by every instance of the part.
   */
  private collectConnectorStates(partId: string): ConnectorState[] {
    const out: ConnectorState[] = [];
    for (const obj of this.allObjects) {
      if (obj.type !== 'connector' || !obj.id || obj.parentId !== partId) continue;
      const data = obj.object as ConnectorData | undefined;
      if (!data) continue;
      if (!data.origin || !data.xDirection || !data.normal) continue;
      out.push({
        connectorId: obj.id,
        localOrigin: new Vector3(data.origin.x, data.origin.y, data.origin.z),
        localXDirection: new Vector3(data.xDirection.x, data.xDirection.y, data.xDirection.z),
        localNormal: new Vector3(data.normal.x, data.normal.y, data.normal.z),
      });
    }
    return out;
  }

  /**
   * The classified exposures one instance carries: the part's own
   * `expose()` publications, shared by every instance of the part —
   * exactly the connector-frames pattern, but for tangent-mate geometry.
   */
  private collectExposureStates(partId: string): ContactState[] {
    const out: ContactState[] = [];
    for (const obj of this.allObjects) {
      if (obj.type !== 'exposed' || !obj.id || obj.parentId !== partId) continue;
      const data = obj.object as ExposedData | undefined;
      if (!data?.name) continue;
      out.push({
        exposeName: data.name,
        seed: data.seed ?? null,
        chain: data.chain ?? [],
      });
    }
    return out;
  }

  /**
   * Set of instance ids that are immovable in the current assembly: a body
   * is "locked" iff its tree-path to its component seed is entirely
   * fastened mates AND the seed is grounded. A grounded body trivially
   * qualifies (it is its own seed). Drags that target one of these must
   * bubble to camera navigation instead of being claimed — same behavior
   * grounded already had, extended to bodies whose constraints leave them
   * with zero DOFs. Built fresh per pointerdown so it reflects any mate /
   * grounded changes since the last gesture.
   */
  private collectBodies(): BodyState[] {
    const bodies: BodyState[] = [];
    for (const state of this.instances.values()) {
      bodies.push({
        instanceId: state.data.instanceId,
        position: state.group.position.clone(),
        quaternion: state.group.quaternion.clone(),
        grounded: state.data.grounded,
        connectors: state.connectors,
        contacts: state.contacts,
      });
    }
    // Origin-frame mate sides resolve against a synthetic grounded world
    // body — appended whenever any committed OR provisional mate references
    // it, so the provisional preview solve (which also reads collectBodies)
    // never drops the candidate mate as unresolvable.
    if (matesReferenceOrigin(this.solverMates())) {
      bodies.push(makeOriginBody());
    }
    return bodies;
  }

  private computeLockedInstanceIds(): Set<string> {
    const bodies = this.collectBodies();
    const graph = buildMateGraph(bodies, this.mates);
    const locked = new Set<string>();
    for (const body of bodies) {
      if (isInstanceFullyLocked(body.instanceId, graph)) {
        locked.add(body.instanceId);
      }
    }
    return locked;
  }

  private buildSolverInput(
    draggedInstanceId?: string,
    draggedTargetOrigin?: Vector3,
  ): SolverInput {
    return {
      bodies: this.collectBodies(),
      mates: this.solverMates(),
      draggedInstanceId,
      draggedTargetOrigin,
    };
  }

  /**
   * The mate set a solve runs against: the committed records plus the
   * provisional one — which REPLACES the committed mate sharing its id.
   * That collision is the edit dialog's preview (solve my candidate instead
   * of the statement it rewrites); create previews use an id no render ever
   * mints, so they append.
   */
  private solverMates(): MateRecord[] {
    const provisional = this.provisionalMate;
    if (!provisional) {
      return this.mates;
    }
    return [...this.mates.filter(m => m.mateId !== provisional.mateId), provisional];
  }

  private applySolverOutput(out: SolverOutput): void {
    // 'inconsistent' poses apply too: the solver already produced the
    // least-bad configuration for a closure gap, and freezing the scene
    // at the last-good frame would make unreachable-drag feedback feel
    // wedged. The DOF pill + joints-panel dots carry the failure signal.
    if (out.result !== 'okay' && out.result !== 'inconsistent') return;
    for (const solved of out.bodies) {
      const state = this.instances.get(solved.instanceId);
      if (!state) continue;
      state.group.position.copy(solved.position);
      state.group.quaternion.copy(solved.quaternion);
    }
  }

  /**
   * Resolve the slider/revolute joint the user is about to manipulate, so a
   * live value can be shown while dragging. Uses the same `buildMateGraph`
   * (seeded on the dragged instance) the solver uses, so driver/follower —
   * and thus the value's sign — match the warm-start and the limit clamp.
   * Prefers the edge whose follower IS the dragged body (its joint to its
   * driver); falls back to one where it drives a follower.
   */
  private findReadoutEdge(draggedInstanceId: string): ReadoutEdge | null {
    const graph = buildMateGraph(this.collectBodies(), this.mates, draggedInstanceId);
    let fallback: ReadoutEdge | null = null;
    for (const comp of graph.components) {
      for (const edge of comp.treeEdges) {
        if (edge.mate.type !== 'slider' && edge.mate.type !== 'revolute') continue;
        const isChild = edge.child.instanceId === draggedInstanceId;
        const isParent = edge.parent.instanceId === draggedInstanceId;
        if (!isChild && !isParent) continue;
        const re: ReadoutEdge = {
          mate: edge.mate,
          driverId: edge.parent.instanceId,
          driverConn: edge.parentConn,
          followerId: edge.child.instanceId,
          followerConn: edge.childConn,
        };
        if (isChild) return re;
        fallback ??= re;
      }
    }
    return fallback;
  }

  /**
   * Compute the active joint's live value from the solved poses and push it
   * to the readout handler. No-op when there's no joint or the solve failed
   * (keeps the last shown value rather than flickering the pill off).
   */
  private emitDragValue(out: SolverOutput): void {
    if (!this.dragValueHandler || !this.dragState) return;
    const edge = this.dragState.readoutEdge;
    // Track 'inconsistent' too — its poses are applied (see
    // applySolverOutput), so the readout must follow them.
    if (!edge || (out.result !== 'okay' && out.result !== 'inconsistent')) return;
    const byId = new Map(out.bodies.map(b => [b.instanceId, b]));
    const d = byId.get(edge.driverId);
    const f = byId.get(edge.followerId);
    if (!d || !f) return;
    const driver: BodyState = {
      instanceId: edge.driverId, position: d.position, quaternion: d.quaternion,
      grounded: false, connectors: [],
    };
    const follower: BodyState = {
      instanceId: edge.followerId, position: f.position, quaternion: f.quaternion,
      grounded: false, connectors: [],
    };
    this.dragValueHandler(
      mateReadoutValue(edge.mate, driver, edge.driverConn, follower, edge.followerConn),
    );
  }

  private runSolverRefresh(): void {
    if (this.instances.size === 0) {
      this.solverUpdateHandler?.({
        bodies: [],
        result: 'okay',
        dof: 0,
        failed: [],
      });
      return;
    }
    try {
      const input = this.buildSolverInput();
      const out = this.solver.solve(input);
      this.applySolverOutput(out);
      this.requestRender();
      this.solverUpdateHandler?.(out);
    } catch (err) {
      console.error('Solver refresh failed:', err);
    }
  }

  /**
   * Re-run a plain (no drag, no driver) solve at the current poses and
   * publish it. The Animate bar calls this when playback pauses so the
   * DOF readout — which reports the driven joint as held while a sweep
   * runs — goes back to the assembly's real count.
   */
  refreshSolve(): void {
    if (this.dragState || this.externalDrag) return;
    this.runSolverRefresh();
  }

  setSolverUpdateHandler(handler: SolverUpdateHandler | null): void {
    this.solverUpdateHandler = handler;
    // Replay the latest state so a freshly-attached panel sees the current
    // DOF without waiting for the next render or drag.
    if (handler && this.instances.size > 0) {
      this.runSolverRefresh();
    }
  }

  private buildInstanceGroup(inst: SerializedAssemblyInstance): Group | null {
    const partTemplate = this.partTemplates.get(inst.partId);
    if (!partTemplate) {
      return null;
    }
    const group = new Group();
    group.name = `instance:${inst.instanceId}`;
    group.userData.instanceId = inst.instanceId;
    group.userData.grounded = inst.grounded;
    group.userData.draggable = !inst.grounded;
    group.position.set(inst.position.x, inst.position.y, inst.position.z);
    group.quaternion.set(inst.quaternion.x, inst.quaternion.y, inst.quaternion.z, inst.quaternion.w);

    const partMesh = buildObjectMesh(partTemplate, this.allObjects, null, this.camera, false);
    group.add(partMesh);
    setConnectorsVisible(group, false);
    return group;
  }

  private disposeGroup(group: Object3D): void {
    group.traverse(child => {
      const mat = (child as any).material;
      if (mat) {
        if (Array.isArray(mat)) {
          for (const m of mat) m.dispose?.();
        } else {
          mat.dispose?.();
        }
      }
    });
  }

  private attachPointerHandlers(): void {
    const dom = this.renderer.domElement;
    // Capture-phase so we run before camera-controls can begin its drag,
    // letting us stopImmediatePropagation() when we claim the event.
    dom.addEventListener('pointerdown', this.handlePointerDown, true);
    dom.addEventListener('pointermove', this.handlePointerMove, true);
    dom.addEventListener('pointerup', this.handlePointerUp, true);
    dom.addEventListener('pointercancel', this.handlePointerUp, true);
  }

  private handlePointerDown = (e: PointerEvent) => {
    // Fresh gesture: any leftover suppress-click flag from a missed mouseup
    // must not leak into this one. (Belt-and-suspenders; consumeRecentDrag
    // normally clears it.)
    this.postDragSuppress = null;
    if (e.button !== 0) return;
    // Dormant while the container is out of the scene (a part file is being
    // viewed — the viewer detaches the container but keeps this controller
    // and its instance groups alive for pose round-tripping). Without this,
    // the raycast below hits the stale invisible instance meshes and claims
    // clicks meant for the part's faces/edges.
    if (!this.container.parent) return;
    // A gizmo drag owns the assembly for the duration — a second pointer
    // (multi-touch) must not start a competing part drag mid-solve.
    if (this.externalDrag) return;
    // A mate dialog is picking connectors — clicks mean "pick", never "move",
    // so the gesture must bubble to the viewer's click path (and camera nav)
    // instead of being claimed as a drag.
    if (this.matePicking) return;
    const ndc = this.toNDC(e);
    const raycaster = this.createPickingRaycaster(ndc.x, ndc.y);
    // Compute the locked set once: both the precise pick and the
    // bounding-box fallback skip locked bodies so the ray falls through to
    // a draggable part behind. Locked = grounded OR fastened-only chain to
    // a grounded seed — same notion the solver uses to zero-drag locked
    // bodies. When nothing draggable is along the ray the hit is null and
    // the gesture bubbles so camera nav handles it.
    const lockedIds = this.computeLockedInstanceIds();
    const hit = this.raycastInstances(raycaster, lockedIds);
    if (!hit) return;

    const state = this.instances.get(hit.instanceId);
    if (!state) return;

    this.dragClaimHandler?.();

    const planeNormal = new Vector3();
    this.camera.getWorldDirection(planeNormal);
    planeNormal.negate();
    const plane = new Plane().setFromNormalAndCoplanarPoint(planeNormal, hit.worldPoint);
    const grabOffset = state.group.position.clone().sub(hit.worldPoint);
    // Body-local grab: invert the body pose to express the hit point in
    // the body's frame. Stays valid as the body moves/rotates.
    const grabLocal = hit.worldPoint.clone()
      .sub(state.group.position)
      .applyQuaternion(state.group.quaternion.clone().invert());

    this.dragState = {
      instanceId: hit.instanceId,
      plane,
      grabOffset,
      grabLocal,
      moved: false,
      downX: e.clientX,
      downY: e.clientY,
      pointerId: e.pointerId,
      lastSolvedClientX: Number.NaN,
      lastSolvedClientY: Number.NaN,
      readoutEdge: this.findReadoutEdge(hit.instanceId),
    };
    (this.renderer.domElement as HTMLElement).setPointerCapture(e.pointerId);
    // Block camera-controls and any other pointerdown listeners on the canvas.
    // We deliberately do NOT call preventDefault — that would suppress the
    // compatibility mouse-event chain (mousedown/mouseup/click) for the whole
    // gesture, which the viewer's hover and click-detection paths rely on.
    e.stopImmediatePropagation();
  };

  private handlePointerMove = (e: PointerEvent) => {
    if (!this.dragState) return;
    const dx = e.clientX - this.dragState.downX;
    const dy = e.clientY - this.dragState.downY;
    if (!this.dragState.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
      return;
    }
    // Skip the solve when the cursor hasn't moved since the last sample.
    // High-rate mice + browser smoothing produce a non-trivial number of
    // pointermove events at the same (clientX, clientY); the result of
    // a re-solve would be identical, so skipping costs nothing visually.
    if (
      e.clientX === this.dragState.lastSolvedClientX
      && e.clientY === this.dragState.lastSolvedClientY
    ) {
      e.stopImmediatePropagation();
      return;
    }
    this.dragState.lastSolvedClientX = e.clientX;
    this.dragState.lastSolvedClientY = e.clientY;
    this.dragState.moved = true;

    const state = this.instances.get(this.dragState.instanceId);
    if (!state) return;

    const ndc = this.toNDC(e);
    const raycaster = this.createPickingRaycaster(ndc.x, ndc.y);
    const intersection = new Vector3();
    if (!raycaster.ray.intersectPlane(this.dragState.plane, intersection)) {
      return;
    }
    // Convert cursor world point → body origin target using the grab
    // offset captured at drag-start. `grabOffset = origin_start - grab_start`
    // is constant across the gesture, so we just add it to the cursor
    // intersection. Re-deriving the offset from the live origin every
    // frame would drift each move (the body has already moved by the prior
    // frame's solve).
    const targetOrigin = intersection.clone().add(this.dragState.grabOffset);

    // Free-body / position path: pass `targetOrigin` so a body with no
    // mates translates to the cursor (offset by grab). Mate-aware path:
    // also pass the cursor world point and body-local grab so JS-side
    // mate handlers (e.g. revolute) can compute the rotation that makes
    // the *grab point* — not the body origin — track the cursor.
    // Body-origin tracking gives the wrong sign whenever the grab is on
    // the opposite side of the pivot from the body origin; the grab-point
    // formulation never does.
    const debugPerf = (globalThis as any).__solverPerf === true;
    if (debugPerf && !(globalThis as any).__solverPerfArmed) {
      (globalThis as any).__solverPerfArmed = true;
      console.warn('[solverPerf] ARMED — drag, then summary prints every 20 events');
    }
    const tBuild0 = debugPerf ? performance.now() : 0;
    const input: SolverInput = {
      ...this.buildSolverInput(this.dragState.instanceId, targetOrigin),
      draggedCursorWorld: intersection.clone(),
      draggedGrabLocal: this.dragState.grabLocal.clone(),
    };
    const tBuild1 = debugPerf ? performance.now() : 0;
    const out = this.solver.solve(input);
    const tSolve1 = debugPerf ? performance.now() : 0;
    if (out.result === 'okay') {
      this.applySolverOutput(out);
    } else {
      // Solver rejected the drag — keep last good pose and let the user
      // drag back into a valid configuration. The update handler reports
      // the status so the joints panel can flash the failing mate.
    }
    this.solverUpdateHandler?.(out);
    this.emitDragValue(out);
    if (debugPerf) {
      const tDone = performance.now();
      const buf = (globalThis as any).__solverPerfBuf ??= [];
      buf.push({ build: +(tBuild1 - tBuild0).toFixed(3), solve: +(tSolve1 - tBuild1).toFixed(3), apply: +(tDone - tSolve1).toFixed(3) });
      if (buf.length >= 20) {
        const avg = (k: 'build' | 'solve' | 'apply') => +(buf.reduce((s: number, x: any) => s + x[k], 0) / buf.length).toFixed(3);
        console.warn(`[solverPerf] last ${buf.length} events: build=${avg('build')}ms solve=${avg('solve')}ms apply=${avg('apply')}ms`);
        buf.length = 0;
      }
    }
    this.requestRender();
    e.stopImmediatePropagation();
  };

  private handlePointerUp = (e: PointerEvent) => {
    if (!this.dragState) return;
    try {
      (this.renderer.domElement as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore — capture may not have been set
    }
    const released = this.dragState;
    this.dragState = null;
    // The gesture started with a drag claim; suppress the corresponding
    // click regardless of whether the cursor moved enough to cross the
    // drag threshold. Storing the instance id (rather than a bare bool)
    // lets the viewer also suppress hover on this specific part until the
    // cursor leaves it — and `moved` lets it tell a plain click (instance
    // selection) apart from a finished drag.
    this.postDragSuppress = { instanceId: released.instanceId, moved: released.moved };
    if (released.moved && this.dragReleaseHandler) {
      const state = this.instances.get(released.instanceId);
      if (state) {
        const p = state.group.position;
        this.dragReleaseHandler(released.instanceId, { x: p.x, y: p.y, z: p.z });
      }
    }
    this.dragValueHandler?.(null);
    e.stopImmediatePropagation();
  };

  /**
   * Abort any pointer gesture and drop the not-yet-consumed drop flag.
   * Called by the viewer when a render switches the scene away from this
   * assembly (a part file's updateView): a drag in flight must not leave
   * {@link isDragGestureActive} stuck true (which would kill hover), and a
   * stale {@link postDragSuppress} must not swallow the first click in the
   * part view. No release handler fires — the gesture is cancelled, not
   * dropped.
   */
  cancelPointerGesture(): void {
    if (this.dragState) {
      try {
        (this.renderer.domElement as HTMLElement).releasePointerCapture(this.dragState.pointerId);
      } catch {
        // ignore — capture may not have been set
      }
      this.dragState = null;
      this.dragValueHandler?.(null);
    }
    this.postDragSuppress = null;
  }

  setDragReleaseHandler(handler: InstanceDragReleaseHandler | null): void {
    this.dragReleaseHandler = handler;
  }

  setDragClaimHandler(handler: InstanceDragClaimHandler | null): void {
    this.dragClaimHandler = handler;
  }

  setDragValueHandler(handler: DragValueHandler | null): void {
    this.dragValueHandler = handler;
  }

  private toNDC(e: PointerEvent): Vector2 {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -(((e.clientY - rect.top) / rect.height) * 2 - 1),
    );
  }

  private raycastInstances(
    raycaster: Raycaster,
    lockedIds: Set<string>,
  ): { instanceId: string; worldPoint: Vector3 } | null {
    const hits = raycaster.intersectObject(this.container, true);
    for (const hit of hits) {
      let cur: Object3D | null = hit.object;
      while (cur) {
        const id = cur.userData?.instanceId;
        if (typeof id === 'string') {
          // three's Raycaster tests only `layers`, never `visible`, so a
          // hidden instance still yields precise mesh hits. Skip it — and
          // skip locked (grounded / fastened-to-ground) instances, which
          // can never be dragged — so the ray reaches whatever draggable
          // part sits behind.
          if (lockedIds.has(id) || this.instances.get(id)?.group.visible === false) {
            break;
          }
          return { instanceId: id, worldPoint: hit.point.clone() };
        }
        cur = cur.parent;
      }
    }
    // Bounding-box fallback: a click that just misses a thin part's silhouette
    // (or nips an edge between facets) won't produce a precise mesh hit, but
    // the user clearly meant to grab the part. Without this, the click falls
    // through to the viewer's selection handler and leaves a stray face
    // highlight on drop. Locked instances (grounded or fastened-chained to
    // ground) are skipped so a near-by immovable doesn't poach the drag from
    // the actually-draggable instance behind it — and so a near-miss on a
    // locked part bubbles to camera navigation instead of being absorbed.
    const box = new Box3();
    const target = new Vector3();
    let best: { instanceId: string; worldPoint: Vector3; dist: number } | null = null;
    for (const [id, state] of this.instances) {
      if (lockedIds.has(id)) continue;
      if (!state.group.visible) {
        continue;
      }
      box.setFromObject(state.group);
      if (box.isEmpty()) continue;
      if (!raycaster.ray.intersectBox(box, target)) continue;
      const dist = raycaster.ray.origin.distanceTo(target);
      if (!best || dist < best.dist) {
        best = { instanceId: id, worldPoint: target.clone(), dist };
      }
    }
    return best ? { instanceId: best.instanceId, worldPoint: best.worldPoint } : null;
  }

  /**
   * True only while the user is actively dragging a part with the cursor
   * past the movement threshold — or the gizmo is driving an external drag.
   * Used by callers that care specifically about active motion (e.g.
   * {@link AssemblyController.update} skipping pose sync for the in-flight
   * instance).
   */
  isDragging(): boolean {
    return this.dragState?.moved === true || this.externalDrag !== null;
  }

  /**
   * True from the moment a drag is claimed (pointerdown on a non-grounded
   * instance) until the controller releases it (pointerup). The viewer's
   * hover handler must consult this — `mousedown`-derived flags can miss
   * gestures when the browser suppresses compatibility mouse events, but
   * pointer events always fire. While true, hover overlays must not be
   * applied.
   */
  isDragGestureActive(): boolean {
    return this.dragState !== null || this.externalDrag !== null;
  }

  /**
   * If the most recent gesture claimed a pointer on a non-grounded
   * instance, returns that gesture (instance id + whether the cursor
   * actually moved) and clears the flag; otherwise `null`. The viewer's
   * mouseup-as-click handler calls this to suppress the face-selection
   * click, drive per-instance hover suppression on the just-dropped part,
   * and — when the gesture never moved — treat the click as an instance
   * selection instead. Self-clears on read.
   */
  consumeRecentDrag(): { instanceId: string; moved: boolean } | null {
    const gesture = this.postDragSuppress;
    this.postDragSuppress = null;
    return gesture;
  }

  // -------------------------------------------------------------------------
  // Mate-dialog connector picking: while a connector slot is armed every
  // gizmo is revealed and clicks resolve by screen distance to the gizmo
  // origins (they render depth-test-off on top, so screen-space nearest
  // matches what the user sees — same approach as the connector tool's
  // anchor float).
  // -------------------------------------------------------------------------

  /**
   * Arm or disarm connector picking. Arming makes {@link handlePointerDown}
   * bail so clicks bubble to the viewer's pick path, and reveals gizmos per
   * `revealAll`: every connector for a create dialog, hover-reveal (plus the
   * pinned slot connectors) for an edit. Disarming hides every connector
   * again — hover reveals nothing while no mate dialog is open — and drops
   * any hover highlight. Any in-flight drag gesture is cancelled — the
   * dialog opened mid-gesture must not leave a claim active.
   */
  setMatePicking(armed: boolean, revealAll = true): void {
    if (this.matePicking === armed && (!armed || this.matePickingRevealAll === revealAll)) {
      return;
    }
    this.matePicking = armed;
    this.matePickingRevealAll = revealAll;
    if (armed) {
      this.cancelPointerGesture();
    } else {
      this.highlightedConnectorId = null;
      this.matePickedSlotKeys.clear();
      this.applyConnectorHighlight();
    }
    for (const state of this.instances.values()) {
      this.applyConnectorVisibility(state);
    }
    this.applyOriginVisibility();
    this.requestRender();
  }

  /**
   * The connectors filling the mate dialog's slots — each pinned on ITS
   * instance only (connector ids are part-scoped, see
   * {@link matePickedSlotKeys}). The service re-sends the set on every slot
   * change and render re-resolve (scene ids are re-minted per render).
   */
  setMatePickedConnectors(slots: Iterable<{ instanceId: string; connectorId: string }>): void {
    this.matePickedSlotKeys = new Set(
      [...slots].map(s => pickedSlotKey(s.instanceId, s.connectorId)),
    );
    for (const state of this.instances.values()) {
      this.applyConnectorVisibility(state);
    }
    this.applyOriginVisibility();
    this.requestRender();
  }

  isMatePicking(): boolean {
    return this.matePicking;
  }

  /**
   * The visible connector gizmo nearest the cursor within `maxPx` screen
   * pixels, or null. Distance is measured to the gizmo origin projected
   * through the live camera.
   */
  pickConnectorAt(
    clientX: number,
    clientY: number,
    maxPx = CONNECTOR_PICK_RADIUS_PX,
  ): { instanceId: string; connectorId: string } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const world = new Vector3();
    let best: { instanceId: string; connectorId: string; distPx: number } | null = null;
    for (const [instanceId, state] of this.instances) {
      // A hidden instance renders nothing, so its connectors must not be
      // screen-pickable — the per-child `visible` check below can't see the
      // ancestor group's flag.
      if (!state.group.visible) {
        continue;
      }
      state.group.traverse((child) => {
        if (!child.userData?.isConnector || !child.visible) return;
        const connectorId = child.userData.connectorId;
        if (typeof connectorId !== 'string') return;
        // The ConnectorMesh group sits at the part-frame origin; the gizmo
        // child inside it carries the connector frame's actual origin.
        const gizmo = child.children[0] ?? child;
        gizmo.getWorldPosition(world).project(this.camera);
        if (world.z > 1) return; // behind the camera
        const px = ((world.x + 1) / 2) * rect.width + rect.left;
        const py = ((1 - world.y) / 2) * rect.height + rect.top;
        const distPx = Math.hypot(px - clientX, py - clientY);
        if (distPx <= maxPx && (!best || distPx < best.distPx)) {
          best = { instanceId, connectorId, distPx };
        }
      });
    }
    // The origin triad competes like any connector while visible — picking
    // it fills the slot with the world frame (`origin()` in the source).
    if (this.originGizmo.visible) {
      const gizmo = this.originGizmo.children[0] ?? this.originGizmo;
      gizmo.getWorldPosition(world).project(this.camera);
      if (world.z <= 1) {
        const px = ((world.x + 1) / 2) * rect.width + rect.left;
        const py = ((1 - world.y) / 2) * rect.height + rect.top;
        const distPx = Math.hypot(px - clientX, py - clientY);
        if (distPx <= maxPx && (!best || distPx < best.distPx)) {
          best = { instanceId: ORIGIN_BODY_ID, connectorId: ORIGIN_CONNECTOR_ID.z, distPx };
        }
      }
    }
    return best ? { instanceId: best.instanceId, connectorId: best.connectorId } : null;
  }

  /**
   * Enlarge one connector's gizmo as hover feedback while picking (`null`
   * clears). Persisted as an id and re-asserted after diff updates.
   */
  setHighlightedConnector(connectorId: string | null): void {
    if (this.highlightedConnectorId === connectorId) return;
    this.highlightedConnectorId = connectorId;
    this.applyConnectorHighlight();
    this.requestRender();
  }

  /**
   * Sync every gizmo's scale multiplier to {@link highlightedConnectorId}.
   * The multiplier rides userData because the gizmo re-derives its scale
   * from the camera on every draw (see buildConnectorGizmo) — a one-shot
   * scale write here would be overwritten by the next frame.
   */
  private applyConnectorHighlight(): void {
    for (const state of this.instances.values()) {
      state.group.traverse((child) => {
        if (!child.userData?.isConnector) return;
        this.applyConnectorOpacity(child, state.data.instanceId);
        const gizmo = child.children[0];
        if (!gizmo) return;
        gizmo.userData.highlight = child.userData.connectorId === this.highlightedConnectorId
          ? CONNECTOR_HIGHLIGHT_SCALE
          : 1;
      });
    }
    this.applyConnectorOpacity(this.originGizmo, ORIGIN_BODY_ID);
    const originInner = this.originGizmo.children[0];
    if (originInner) {
      originInner.userData.highlight =
        this.originGizmo.userData.connectorId === this.highlightedConnectorId
          ? CONNECTOR_HIGHLIGHT_SCALE
          : 1;
    }
  }

  /**
   * Solve a not-yet-committed mate live (the dialog's preview), or clear it.
   * A record sharing a committed mate's id replaces that mate in the solve
   * (see {@link solverMates}) — how the edit dialog previews its candidate
   * without the original fighting it. Clearing restores every instance to
   * its serialized source-of-truth pose before re-solving, so cancelling
   * the dialog snaps the preview motion back instead of leaving the parts
   * wherever the provisional solve put them.
   */
  setProvisionalMate(record: MateRecord | null): void {
    const clearing = record === null && this.provisionalMate !== null;
    if (record === null && this.provisionalMate === null) return;
    this.provisionalMate = record;
    if (clearing) {
      for (const state of this.instances.values()) {
        const d = state.data;
        state.group.position.set(d.position.x, d.position.y, d.position.z);
        state.group.quaternion.set(d.quaternion.x, d.quaternion.y, d.quaternion.z, d.quaternion.w);
      }
    }
    this.runSolverRefresh();
  }

  /**
   * The provisional mate was committed to the source: forget the record but
   * keep the preview's solved poses on screen — no serialized-pose restore,
   * no re-solve. The committed statement's render re-solves with the real
   * mate to the same configuration, so the parts hold the preview pose
   * instead of flashing back through their unmated positions while that
   * render is in flight.
   */
  commitProvisionalMate(): void {
    this.provisionalMate = null;
  }

  /** The connector's registered name (`connector('name', …)`) — null when unknown. */
  getConnectorName(connectorId: string): string | null {
    for (const obj of this.allObjects) {
      if (obj.type === 'connector' && obj.id === connectorId) {
        const data = obj.object as ConnectorData | undefined;
        return data?.name ?? obj.name ?? null;
      }
    }
    return null;
  }

  /**
   * Where the connector's `connector()` statement lives — its part file and
   * line, for the pen-button property editor. Null when the render carried
   * no source location for it.
   */
  getConnectorSourceLocation(connectorId: string): { filePath: string; line: number } | null {
    for (const obj of this.allObjects) {
      if (obj.type === 'connector' && obj.id === connectorId && obj.sourceLocation) {
        return { filePath: obj.sourceLocation.filePath, line: obj.sourceLocation.line };
      }
    }
    return null;
  }

  /**
   * The current render's scene id for the named connector on an instance —
   * how a mate dialog's pick re-finds itself after a render re-mints every
   * id. Null when the instance or the name is gone.
   */
  findConnectorId(instanceId: string, connectorName: string): string | null {
    const partId = this.instances.get(instanceId)?.data.partId;
    if (!partId) {
      return null;
    }
    for (const obj of this.allObjects) {
      if (obj.type !== 'connector' || !obj.id || obj.parentId !== partId) continue;
      const data = obj.object as ConnectorData | undefined;
      if ((data?.name ?? obj.name) === connectorName) {
        return obj.id;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // External (gizmo-driven) drags: the transform gizmo computes constrained
  // targets and routes them through the same solver loop the pointer drag
  // uses, so mated bodies behave identically under both.
  // -------------------------------------------------------------------------

  /**
   * Whether the instance is immovable (grounded, or fastened-only chain to
   * a grounded seed — the same set pointer drags refuse). Unknown ids read
   * as locked.
   */
  isInstanceLocked(instanceId: string): boolean {
    if (!this.instances.has(instanceId)) {
      return true;
    }
    return this.computeLockedInstanceIds().has(instanceId);
  }

  /**
   * Claim a programmatic drag on the instance. Refused (false) when the
   * instance is unknown or locked, or any drag — pointer or external — is
   * already active.
   */
  beginExternalDrag(instanceId: string): boolean {
    if (this.dragState || this.externalDrag) {
      return false;
    }
    if (this.isInstanceLocked(instanceId)) {
      return false;
    }
    this.externalDrag = { instanceId };
    return true;
  }

  /**
   * Solver-in-the-loop translation toward `targetOrigin` (world). The grab
   * point is the body origin itself (`draggedGrabLocal` zero), so free
   * bodies land exactly on the target and mate-aware handlers steer the
   * origin toward it. Null when no external drag is active or the instance
   * disappeared mid-drag (caller should cancel).
   */
  updateExternalDragTranslate(targetOrigin: Vector3): SolverOutput | null {
    const drag = this.externalDrag;
    if (!drag || !this.instances.has(drag.instanceId)) {
      return null;
    }
    const input: SolverInput = {
      ...this.buildSolverInput(drag.instanceId, targetOrigin.clone()),
      draggedCursorWorld: targetOrigin.clone(),
      draggedGrabLocal: new Vector3(0, 0, 0),
    };
    const out = this.solver.solve(input);
    if (out.result === 'okay') {
      this.applySolverOutput(out);
    }
    this.solverUpdateHandler?.(out);
    this.requestRender();
    return out;
  }

  /**
   * Solver-in-the-loop rotation: write the quaternion onto the live group
   * (position untouched — the gizmo pivots at the body origin), then
   * re-solve seeded at this body so followers re-derive from it and the
   * warm start projects the new orientation onto the mate manifold. Free
   * bodies pass through unchanged.
   */
  updateExternalDragRotate(quaternion: Quaternion): SolverOutput | null {
    const drag = this.externalDrag;
    if (!drag) {
      return null;
    }
    const state = this.instances.get(drag.instanceId);
    if (!state) {
      return null;
    }
    state.group.quaternion.copy(quaternion);
    const out = this.solver.solve(this.buildSolverInput(drag.instanceId));
    if (out.result === 'okay') {
      this.applySolverOutput(out);
    }
    this.solverUpdateHandler?.(out);
    this.requestRender();
    return out;
  }

  // -------------------------------------------------------------------------
  // Mate animation: drive a 1-DOF mate (revolute angle / slider travel) to
  // an explicit value. Used by the Animate bar; shares the gizmo-rotate
  // path's solve-seeded-at-the-moved-body so chained followers re-derive
  // and closed loops relax exactly as they do under a pointer drag.
  // -------------------------------------------------------------------------

  /**
   * The spanning-forest tree edge carrying `mateId`, built the way a
   * no-drag solve builds it (grounded roots). Null when the mate is
   * unknown, a closure edge (a loop's redundant mate can't be driven —
   * the tree edges own the loop's configuration), or not slider/revolute.
   */
  private findDriveEdge(mateId: string): TreeEdge | null {
    const graph = buildMateGraph(this.collectBodies(), this.solverMates());
    for (const comp of graph.components) {
      for (const edge of comp.treeEdges) {
        if (edge.mate.mateId !== mateId) continue;
        if (edge.mate.type !== 'slider' && edge.mate.type !== 'revolute') return null;
        return edge;
      }
    }
    return null;
  }

  /**
   * Whether the mate can be animated, plus its current authored-space
   * value. Null when it can't (see {@link findDriveEdge}).
   */
  getMateDriveState(mateId: string): MateReadout | null {
    const edge = this.findDriveEdge(mateId);
    if (!edge) return null;
    return mateReadoutValue(edge.mate, edge.parent, edge.parentConn, edge.child, edge.childConn);
  }

  /**
   * Solve with the mate held at `value` (degrees / mm, the readout's
   * space) as a kinematic driver: the follower is posed there and the
   * loop relaxation solves closures/contacts AROUND it (see
   * SolverInput.drivenJoint). `.limits()` still clamp — an out-of-range
   * value pins at the bound. Returns the solver output, or null when the
   * mate can't be driven or a pointer / gizmo drag owns the assembly.
   */
  driveMateValue(mateId: string, value: number): SolverOutput | null {
    if (this.dragState || this.externalDrag) return null;
    if (!this.findDriveEdge(mateId)) return null;
    const out = this.solver.solve({
      ...this.buildSolverInput(),
      drivenJoint: { mateId, value },
    });
    this.applySolverOutput(out);
    this.solverUpdateHandler?.(out);
    this.requestRender();
    return out;
  }

  /** Read the final pose off the live group and release the claim. */
  endExternalDrag(): { position: Vector3; quaternion: Quaternion } | null {
    const drag = this.externalDrag;
    this.externalDrag = null;
    if (!drag) {
      return null;
    }
    const state = this.instances.get(drag.instanceId);
    if (!state) {
      return null;
    }
    return {
      position: state.group.position.clone(),
      quaternion: state.group.quaternion.clone(),
    };
  }

  /**
   * Abandon the external drag and restore the pose the gesture started
   * from (the caller holds it — typically the serialized payload values),
   * then re-solve so followers settle back too.
   */
  cancelExternalDrag(pose: { position: Vector3; quaternion: Quaternion }): void {
    const drag = this.externalDrag;
    this.externalDrag = null;
    if (!drag) {
      return;
    }
    const state = this.instances.get(drag.instanceId);
    if (!state) {
      return;
    }
    state.group.position.copy(pose.position);
    state.group.quaternion.copy(pose.quaternion);
    this.runSolverRefresh();
  }

  /** The instance's current on-screen pose, or null when it isn't rendered. */
  getInstancePose(instanceId: string): { position: Vector3; quaternion: Quaternion } | null {
    const state = this.instances.get(instanceId);
    if (!state) {
      return null;
    }
    return {
      position: state.group.position.clone(),
      quaternion: state.group.quaternion.clone(),
    };
  }

  setInstanceVisible(instanceId: string, visible: boolean): void {
    const state = this.instances.get(instanceId);
    if (!state) return;
    state.group.visible = visible;
    this.requestRender();
  }

  isInstanceVisible(instanceId: string): boolean {
    const state = this.instances.get(instanceId);
    return state ? state.group.visible : true;
  }

  /**
   * Tint an instance's faces with the highlight color. Stores the original
   * color on the material so {@link clearHighlight} can restore it. Pairs
   * with the parts panel's "click row to highlight" interaction.
   */
  highlightInstance(instanceId: string, color: number): void {
    this.clearHighlight();
    const state = this.instances.get(instanceId);
    if (!state) return;
    this.tintInstance(state, color);
    this.requestRender();
  }

  /**
   * Highlight both instances participating in a mate and pin the two
   * connectors involved so they remain visible. Pairs with the joints
   * panel's row-click interaction.
   */
  highlightMate(mate: SerializedAssemblyMate, color: number): void {
    this.clearHighlight();
    // Tangent mates carry geometry sides — tint the instances, no
    // connector gizmos to pin.
    const aId = mate.connectorA?.instanceId ?? mate.geometryA?.instanceId;
    const bId = mate.connectorB?.instanceId ?? mate.geometryB?.instanceId;
    const a = aId !== undefined ? this.instances.get(aId) : undefined;
    const b = bId !== undefined ? this.instances.get(bId) : undefined;
    if (a) {
      this.tintInstance(a, color);
      if (mate.connectorA) this.pinConnectorOnInstance(a, mate.connectorA.connectorId);
    }
    if (b) {
      this.tintInstance(b, color);
      if (mate.connectorB) this.pinConnectorOnInstance(b, mate.connectorB.connectorId);
    }
    // An origin-frame side pins the world triad so the joint's fixed end
    // stays visible too.
    if (mate.frameA || mate.frameB) {
      this.originPinned = true;
      this.applyOriginVisibility();
    }
    this.requestRender();
  }

  /**
   * The classified exposure one instance publishes under `exposeName` —
   * the tangent edit dialog's chip seeding and the provisional record's
   * inline contact data both read from here.
   */
  getContactState(instanceId: string, exposeName: string): ContactState | null {
    const state = this.instances.get(instanceId);
    return state?.contacts.find(c => c.exposeName === exposeName) ?? null;
  }

  private tintInstance(state: InstanceState, color: number): void {
    // Walk manually so we can prune the connector subtrees — their
    // X/Y/Z axis materials must keep their original red/green/blue.
    const walk = (obj: Object3D) => {
      if (obj.userData?.isConnector) return;
      const mat = (obj as any).material;
      if (mat && mat.color) {
        if (obj.userData.assemblyOriginalColor === undefined) {
          obj.userData.assemblyOriginalColor = mat.color.getHex();
        }
        mat.color.setHex(color);
      }
      for (const child of obj.children) walk(child);
    };
    walk(state.group);
  }

  private pinConnectorOnInstance(state: InstanceState, connectorId: string): void {
    state.group.traverse((child) => {
      if (child.userData?.isConnector && child.userData?.connectorId === connectorId) {
        this.mateRevealedConnectors.add(child);
      }
    });
    this.applyConnectorVisibility(state);
  }

  clearHighlight(): void {
    this.container.traverse((child) => {
      if (child.userData.assemblyOriginalColor !== undefined) {
        const mat = (child as any).material;
        if (mat?.color) {
          mat.color.setHex(child.userData.assemblyOriginalColor);
        }
        delete child.userData.assemblyOriginalColor;
      }
    });
    if (this.mateRevealedConnectors.size > 0) {
      this.mateRevealedConnectors.clear();
      for (const state of this.instances.values()) {
        this.applyConnectorVisibility(state);
      }
    }
    if (this.originPinned) {
      this.originPinned = false;
      this.applyOriginVisibility();
    }
    this.requestRender();
  }

  hasInstance(instanceId: string): boolean {
    return this.instances.has(instanceId);
  }

  /**
   * Returns the live Three.js group that backs an instance, or null if the
   * id is unknown. Callers should not cache the returned reference across
   * renders — diff updates may replace the group.
   */
  getInstanceGroup(instanceId: string): Group | null {
    return this.instances.get(instanceId)?.group ?? null;
  }
}

// Avoid unused import flagged by tsc
void Quaternion;

function setConnectorsVisible(root: Object3D, visible: boolean): void {
  root.traverse((child) => {
    if (child.userData?.isConnector) {
      child.visible = visible;
    }
  });
}

/**
 * The composite key a mate-dialog slot pins its connector under: connector
 * ids are part-scoped (every instance of the part shares them), so pinning
 * needs the instance too. NUL never appears in scene ids.
 */
function pickedSlotKey(instanceId: string, connectorId: string): string {
  return `${instanceId}\0${connectorId}`;
}

function toMateRecord(m: SerializedAssemblyMate): MateRecord {
  return {
    mateId: m.mateId,
    type: m.type,
    // Origin-frame sides become ordinary connector refs on the synthetic
    // grounded world body — the solver stays frame-unaware.
    connectorA: m.frameA ? originConnectorRef(m.frameA) : m.connectorA,
    connectorB: m.frameB ? originConnectorRef(m.frameB) : m.connectorB,
    geometryA: m.geometryA,
    geometryB: m.geometryB,
    options: m.options,
  };
}
