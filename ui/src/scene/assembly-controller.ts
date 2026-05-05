import { Box3, Camera, Group, Object3D, Plane, Quaternion, Raycaster, Vector2, Vector3, WebGLRenderer } from 'three';
import { ConnectorData, SceneObjectRender, SerializedAssembly, SerializedAssemblyInstance, SerializedAssemblyMate } from '../types';
import { buildObjectMesh } from '../meshes/mesh-factory';
import { Solver } from '../solver';
import type { BodyState, ConnectorState, MateRecord, SolverInput, SolverOutput } from '../solver';

const DRAG_THRESHOLD_PX = 4;

type InstanceState = {
  data: SerializedAssemblyInstance;
  group: Group;
  connectors: ConnectorState[];
};

export type InstanceDragReleaseHandler = (
  instanceId: string,
  position: { x: number; y: number; z: number },
) => void;

export type InstanceDragClaimHandler = () => void;

export type SolverUpdateHandler = (output: SolverOutput) => void;

export class AssemblyController {
  private container = new Group();
  private instances = new Map<string, InstanceState>();
  private partTemplates = new Map<string, SceneObjectRender>();
  private allObjects: SceneObjectRender[] = [];
  private mates: MateRecord[] = [];
  private dragReleaseHandler: InstanceDragReleaseHandler | null = null;
  private dragClaimHandler: InstanceDragClaimHandler | null = null;
  private solverUpdateHandler: SolverUpdateHandler | null = null;
  private solver = new Solver();
  /**
   * Instance whose connectors are currently revealed by hover. Connectors
   * are hidden by default in assembly mode and only shown for the part the
   * cursor is on. Tracking the id (not a Group ref) keeps it valid across
   * diff updates that may replace the underlying group.
   */
  private hoveredInstanceId: string | null = null;
  /**
   * Set on pointerup to the instanceId whose drag just ended (or `null`
   * once consumed / between gestures). Read via {@link consumeRecentDrag}:
   * if non-null, the viewer's mouseup-as-click handler suppresses the
   * face-selection click and uses the instance id to suppress hover on the
   * just-dropped part until the cursor leaves it. Eagerly cleared at the
   * start of the next pointerdown so it can never leak across gestures if
   * a mouseup is missed.
   */
  private postDragSuppressInstanceId: string | null = null;

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
  } | null = null;

  constructor(
    private renderer: WebGLRenderer,
    private camera: Camera,
    private requestRender: () => void,
    private createPickingRaycaster: (ndcX: number, ndcY: number) => Raycaster,
  ) {
    this.container.name = 'assemblyContainer';
    this.attachPointerHandlers();
    // Kick off the WASM load so the first drag doesn't pay the latency.
    // Failures aren't fatal — the controller falls back to free-body drag.
    this.solver.ensureReady().catch((err) => {
      console.error('Failed to load solvespace solver:', err);
    });
  }

  getContainer(): Group {
    return this.container;
  }

  /**
   * Diff incoming assembly data against current state. The source is the
   * source of truth for poses (phase 03b: drag-release writes `.at(...)` back
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
      const existing = this.instances.get(inst.instanceId);
      if (existing) {
        existing.data = inst;
        existing.connectors = connectors;
        existing.group.userData.grounded = inst.grounded;
        existing.group.userData.draggable = !inst.grounded;
        if (this.dragState?.instanceId !== inst.instanceId) {
          existing.group.position.set(inst.position.x, inst.position.y, inst.position.z);
          existing.group.quaternion.set(
            inst.quaternion.x, inst.quaternion.y, inst.quaternion.z, inst.quaternion.w,
          );
        }
        continue;
      }
      const group = this.buildInstanceGroup(inst);
      if (!group) continue;
      this.instances.set(inst.instanceId, { data: inst, group, connectors });
      this.container.add(group);
    }

    // Kick a no-drag solve so the DOF readout reflects the current state.
    // No-op for poses while phase 05 has no mates, but the solver result
    // (DOF, okay/inconsistent) still informs the footer pill.
    this.scheduleSolverRefresh();
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
  }

  /**
   * Reveal connectors for the instance the cursor is on, hiding any
   * previously-revealed set. Connectors are hidden by default in assembly
   * mode (see {@link buildInstanceGroup}); the viewer's hover handler drives
   * this method based on pick results. Pass `null` to hide all.
   */
  setHoveredInstance(instanceId: string | null): void {
    if (this.hoveredInstanceId === instanceId) return;
    if (this.hoveredInstanceId) {
      const prev = this.instances.get(this.hoveredInstanceId);
      if (prev) setConnectorsVisible(prev.group, false);
    }
    this.hoveredInstanceId = instanceId;
    if (instanceId) {
      const next = this.instances.get(instanceId);
      if (next) setConnectorsVisible(next.group, true);
    }
    this.requestRender();
  }

  private collectConnectorStates(partId: string): ConnectorState[] {
    const out: ConnectorState[] = [];
    for (const obj of this.allObjects) {
      if (obj.type !== 'connector' || obj.parentId !== partId || !obj.id) continue;
      const data = obj.object as ConnectorData | undefined;
      if (!data) continue;
      out.push({
        connectorId: obj.id,
        localOrigin: new Vector3(data.origin.x, data.origin.y, data.origin.z),
        localXDirection: new Vector3(data.xDirection.x, data.xDirection.y, data.xDirection.z),
        localNormal: new Vector3(data.normal.x, data.normal.y, data.normal.z),
      });
    }
    return out;
  }

  private buildSolverInput(
    draggedInstanceId?: string,
    draggedTargetOrigin?: Vector3,
  ): SolverInput {
    const bodies: BodyState[] = [];
    for (const state of this.instances.values()) {
      bodies.push({
        instanceId: state.data.instanceId,
        position: state.group.position.clone(),
        quaternion: state.group.quaternion.clone(),
        grounded: state.data.grounded,
        connectors: state.connectors,
      });
    }
    return {
      bodies,
      mates: this.mates,
      draggedInstanceId,
      draggedTargetOrigin,
    };
  }

  private applySolverOutput(out: SolverOutput): void {
    if (out.result !== 'okay') return;
    for (const solved of out.bodies) {
      const state = this.instances.get(solved.instanceId);
      if (!state) continue;
      state.group.position.copy(solved.position);
      state.group.quaternion.copy(solved.quaternion);
    }
  }

  private scheduleSolverRefresh(): void {
    if (!this.solver.isReady()) {
      // Wait for the WASM and try again. Don't block the render path.
      this.solver.ensureReady().then(() => this.runSolverRefresh()).catch(() => {});
      return;
    }
    this.runSolverRefresh();
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

  setSolverUpdateHandler(handler: SolverUpdateHandler | null): void {
    this.solverUpdateHandler = handler;
    // Replay the latest state so a freshly-attached panel sees the current
    // DOF without waiting for the next render or drag.
    if (handler && this.solver.isReady() && this.instances.size > 0) {
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
    this.postDragSuppressInstanceId = null;
    if (e.button !== 0) return;
    const ndc = this.toNDC(e);
    const raycaster = this.createPickingRaycaster(ndc.x, ndc.y);
    const hit = this.raycastInstances(raycaster);
    if (!hit) return;

    const state = this.instances.get(hit.instanceId);
    if (!state || state.data.grounded) return;

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

    if (this.solver.isReady()) {
      // Free-body / position-pin path: pass `targetOrigin` so slvs's
      // dragged[] anchors the body origin to the cursor (offset by grab).
      // Mate-aware path: also pass the cursor world point and body-local
      // grab so JS-side mate handlers (e.g. revolute) can compute the
      // rotation that makes the *grab point* — not the body origin —
      // track the cursor. Body-origin tracking gives the wrong sign
      // whenever the grab is on the opposite side of the pivot from
      // the body origin; the grab-point formulation never does.
      const input: SolverInput = {
        ...this.buildSolverInput(this.dragState.instanceId, targetOrigin),
        draggedCursorWorld: intersection.clone(),
        draggedGrabLocal: this.dragState.grabLocal.clone(),
      };
      const out = this.solver.solve(input);
      if (out.result === 'okay') {
        this.applySolverOutput(out);
      } else {
        // Solver rejected the drag — keep last good pose and let the user
        // drag back into a valid configuration. Phase 06+ flashes the
        // failing mate via the update handler; phase 05 just reports the
        // status and leaves the body where it was.
      }
      this.solverUpdateHandler?.(out);
    } else {
      // Solver hasn't loaded yet — fall back to free-body translation so
      // the user isn't blocked. Becomes solver-driven once WASM resolves.
      state.group.position.copy(targetOrigin);
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
    // cursor leaves it.
    this.postDragSuppressInstanceId = released.instanceId;
    if (released.moved && this.dragReleaseHandler) {
      const state = this.instances.get(released.instanceId);
      if (state) {
        const p = state.group.position;
        this.dragReleaseHandler(released.instanceId, { x: p.x, y: p.y, z: p.z });
      }
    }
    e.stopImmediatePropagation();
  };

  setDragReleaseHandler(handler: InstanceDragReleaseHandler | null): void {
    this.dragReleaseHandler = handler;
  }

  setDragClaimHandler(handler: InstanceDragClaimHandler | null): void {
    this.dragClaimHandler = handler;
  }

  private toNDC(e: PointerEvent): Vector2 {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -(((e.clientY - rect.top) / rect.height) * 2 - 1),
    );
  }

  private raycastInstances(raycaster: Raycaster): { instanceId: string; worldPoint: Vector3 } | null {
    const hits = raycaster.intersectObject(this.container, true);
    for (const hit of hits) {
      let cur: Object3D | null = hit.object;
      while (cur) {
        const id = cur.userData?.instanceId;
        if (typeof id === 'string') {
          return { instanceId: id, worldPoint: hit.point.clone() };
        }
        cur = cur.parent;
      }
    }
    // Bounding-box fallback: a click that just misses a thin part's silhouette
    // (or nips an edge between facets) won't produce a precise mesh hit, but
    // the user clearly meant to grab the part. Without this, the click falls
    // through to the viewer's selection handler and leaves a stray face
    // highlight on drop. Grounded instances are skipped so a near-by ground
    // doesn't poach the drag from the actually-draggable instance behind it.
    const box = new Box3();
    const target = new Vector3();
    let best: { instanceId: string; worldPoint: Vector3; dist: number } | null = null;
    for (const [id, state] of this.instances) {
      if (state.data.grounded) continue;
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
   * past the movement threshold. Used by callers that care specifically
   * about active motion (e.g. {@link AssemblyController.update} skipping
   * pose sync for the in-flight instance).
   */
  isDragging(): boolean {
    return this.dragState?.moved === true;
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
    return this.dragState !== null;
  }

  /**
   * If the most recent gesture ended a drag on a non-grounded instance,
   * returns that instance's id and clears the flag. Otherwise returns
   * `null`. The viewer's mouseup-as-click handler calls this both to
   * suppress the face-selection click and to drive per-instance hover
   * suppression on the just-dropped part. Self-clears on read.
   */
  consumeRecentDrag(): string | null {
    const id = this.postDragSuppressInstanceId;
    this.postDragSuppressInstanceId = null;
    return id;
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
    state.group.traverse((child) => {
      const mat = (child as any).material;
      if (!mat || !mat.color) return;
      if (child.userData.assemblyOriginalColor === undefined) {
        child.userData.assemblyOriginalColor = mat.color.getHex();
      }
      mat.color.setHex(color);
    });
    this.requestRender();
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

function toMateRecord(m: SerializedAssemblyMate): MateRecord {
  return {
    mateId: m.mateId,
    type: m.type,
    connectorA: m.connectorA,
    connectorB: m.connectorB,
    options: m.options,
  };
}
