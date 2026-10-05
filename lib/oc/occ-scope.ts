import type { OpenCascadeInstance } from "ocjs-fluidcad";
import { Shape } from "../common/shape.js";
import { BooleanBuilders } from "./boolean-builders.js";
import { getOC } from "./init.js";

/** An object of the binding: freed with `delete()`. */
type BoundObject = { delete(): void; isDeleted?(): boolean };

export type OccScopeOptions = {
  /**
   * The shapes the scope must never free a raw handle of — what the scene
   * holds. Asked lazily, only when the scope holds a shape handle that
   * nothing it returned or kept retains.
   */
  survivors?: () => Iterable<Shape>;
};

/**
 * The scope raw OpenCascade code runs in — what `this.occ(scope => …)`
 * hands a feature's code — which frees, when it ends, every object the code
 * made, so a custom feature's raw code doesn't leak into the engine's heap
 * on every render.
 *
 * Tracking is automatic for what is constructed: {@link oc} is a proxy of
 * the instance whose classes record each `new`. What a method returns goes
 * in with {@link track}. When the scope ends — returning or throwing —
 * everything recorded is released in reverse order:
 *
 * - a transient's handle (`Geom_*`, `Poly_*`, a history) and a shape
 *   handle (`TopoDS_Shape` and its kinds) are nulled, then deleted: nulling
 *   drops their reference to the data they share, which `delete()` alone
 *   keeps — the binding's `delete()` skips the C++ destructor;
 * - any other object with a `Clear()` (the booleans, explorers, locations)
 *   is cleared, then deleted ({@link BooleanBuilders.release}): clearing is
 *   what frees the internals the skipped destructor would have;
 * - anything else is deleted;
 * - **never** an object the scope returns or keeps, nor a raw handle one
 *   of the returned or kept shape wrappers holds, nor one the scene holds
 *   ({@link OccScopeOptions.survivors}): freeing those would pull geometry
 *   out from under the model.
 *
 * The binding still can't free everything: an object whose internals only
 * its destructor releases (an algorithm without `Clear()`) leaves them on
 * the heap even when the scope deletes it. An ocjs build whose `delete()`
 * runs the destructor frees all of it.
 */
export class OccScope {
  /**
   * The OpenCascade instance. Every object constructed through it —
   * `new scope.oc.gp_Pnt(0, 0, 1)`, `new scope.oc.BRepOffsetAPI_ThruSections(true)` —
   * belongs to the scope, which frees it when it ends.
   */
  readonly oc: OpenCascadeInstance;

  /**
   * Take a value out of the scope: an object the code stores past it. A
   * shape wrapper (`Solid`, `Face`, …) keeps every raw handle it holds.
   * Returns the value. What the scope returns is kept already. Bound, so it
   * can be destructured: `({ oc, keep }) => …`.
   */
  readonly keep = <T>(value: T): T => {
    this.kept.push(value);
    return value;
  };

  /**
   * Hand the scope an object it did not see being made — what a method or
   * a static function returns (`maker.Shape()`, `oc.TopoDS.Wire(shape)`) is
   * the caller's to free too. Returns the object. Bound, like {@link keep}.
   */
  readonly track = <T>(value: T): T => {
    if (OccScope.isBound(value)) {
      this.record(value);
    } else if (value !== null && value !== undefined) {
      throw new Error(`occ(): track() takes an object of the OpenCascade binding, got ${OccScope.describe(value)}`);
    }
    return value;
  };

  private readonly tracked: BoundObject[] = [];
  private readonly kept: unknown[] = [];
  private readonly classes = new Map<Function, Function>();
  private closed = false;

  private constructor(private readonly instance: OpenCascadeInstance, private readonly options: OccScopeOptions) {
    const scope = this;
    this.oc = new Proxy(instance, {
      get(target, name, receiver) {
        const value = Reflect.get(target, name, receiver);
        return OccScope.isBoundClass(value) ? scope.trackingClass(value) : value;
      },
    });
  }

  /**
   * Run `fn` in a fresh scope and free what it made. The scope closes when
   * `fn` returns or throws; `fn` must not be async — a scope can't outlive
   * the build that opened it.
   */
  static run<T>(fn: (scope: OccScope) => T, options: OccScopeOptions = {}): T {
    const scope = new OccScope(getOC(), options);
    let result: T | undefined;
    try {
      result = fn(scope);
      if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
        throw new Error('occ(): the scope runs synchronously — it can\'t outlive the build that opened it, so its function must not be async');
      }
      return result;
    } finally {
      scope.close(result);
    }
  }

  /** The proxy of one bound class: `new` records the object it makes. */
  private trackingClass(cls: Function): Function {
    let proxy = this.classes.get(cls);
    if (!proxy) {
      proxy = new Proxy(cls, {
        construct: (target, args) => {
          const made = Reflect.construct(target, args) as BoundObject;
          this.record(made);
          return made;
        },
      });
      this.classes.set(cls, proxy);
    }
    return proxy;
  }

  private record(value: BoundObject): void {
    if (this.closed) {
      throw new Error('occ(): the scope has closed — keep raw OpenCascade code inside the function this.occ() runs');
    }
    this.tracked.push(value);
  }

  /** Free what the scope made, sparing what it returned, kept or the scene holds. */
  private close(result: unknown): void {
    this.closed = true;
    if (this.tracked.length === 0) {
      return;
    }
    const retained = new Set<object>();
    const seen = new Set<object>();
    OccScope.collectRaw(result, retained, seen);
    for (const value of this.kept) {
      OccScope.collectRaw(value, retained, seen);
    }
    let sceneHeld: Set<object> | null = null;
    const shapeClass = (this.instance as unknown as { TopoDS_Shape: Function }).TopoDS_Shape;
    const released = new Set<object>();
    for (let i = this.tracked.length - 1; i >= 0; i--) {
      const value = this.tracked[i];
      if (retained.has(value) || released.has(value) || OccScope.isDeleted(value)) {
        continue;
      }
      if (value instanceof shapeClass) {
        sceneHeld ??= this.sceneHeld();
        if (sceneHeld.has(value)) {
          continue;
        }
      }
      released.add(value);
      OccScope.release(value);
    }
  }

  /** Every raw handle a shape the scene holds points at. */
  private sceneHeld(): Set<object> {
    const raw = new Set<object>();
    const shapes = this.options.survivors?.() ?? [];
    for (const shape of shapes) {
      shape.collectRawHandles(raw);
    }
    return raw;
  }

  /**
   * Free one object the way the binding lets it be freed: an algorithm
   * cleared first, a handle nulled first, then deleted. A failure freeing
   * one never stops the rest — nor masks what the scope returned or threw.
   */
  private static release(value: BoundObject): void {
    const object = value as BoundObject & { Clear?: unknown; Nullify?: unknown; nullify?: unknown };
    try {
      if (typeof object.nullify === 'function') {
        // A transient's handle (`Geom_*`, `Poly_Triangulation`, a history):
        // the data may be shared — a face holds its triangulation — so it is
        // never cleared, only let go of.
        (object.nullify as () => void).call(object);
      } else if (typeof object.Clear === 'function' && object.Clear.length === 0) {
        BooleanBuilders.release(object as BoundObject & { Clear(): void });
        return;
      } else if (typeof object.Nullify === 'function' && object.Nullify.length === 0) {
        (object.Nullify as () => void).call(object);
      }
    } catch {
      // Freed below all the same.
    }
    try {
      if (!OccScope.isDeleted(value)) {
        value.delete();
      }
    } catch {
      // Already gone: nothing left to free.
    }
  }

  /**
   * Every bound object `value` holds on to: a shape wrapper's raw handles
   * (and those of the sub-shape wrappers it cached), a bound object itself,
   * and whatever an array, a map, a set or a plain object holds.
   */
  private static collectRaw(value: unknown, out: Set<object>, seen: Set<object>): void {
    if (!value || typeof value !== 'object' || seen.has(value)) {
      return;
    }
    seen.add(value);
    if (value instanceof Shape) {
      value.collectRawHandles(out);
      for (const linked of value.getLinkedShapes()) {
        OccScope.collectRaw(linked, out, seen);
      }
      return;
    }
    if (OccScope.isBound(value)) {
      out.add(value);
      return;
    }
    if (Array.isArray(value) || value instanceof Set) {
      for (const entry of value) {
        OccScope.collectRaw(entry, out, seen);
      }
      return;
    }
    if (value instanceof Map) {
      for (const entry of value.values()) {
        OccScope.collectRaw(entry, out, seen);
      }
      return;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      for (const entry of Object.values(value)) {
        OccScope.collectRaw(entry, out, seen);
      }
    }
  }

  /** A class of the binding: a constructor whose instances free themselves with `delete()`. */
  private static isBoundClass(value: unknown): value is Function {
    return typeof value === 'function' && typeof (value as { prototype?: { delete?: unknown } }).prototype?.delete === 'function';
  }

  /** An object of the binding. */
  private static isBound(value: unknown): value is BoundObject {
    return value !== null && typeof value === 'object'
      && typeof (value as BoundObject).delete === 'function'
      && typeof (value as BoundObject).isDeleted === 'function';
  }

  private static isDeleted(value: BoundObject): boolean {
    try {
      return value.isDeleted?.() === true;
    } catch {
      return true;
    }
  }

  private static describe(value: unknown): string {
    if (value instanceof Shape) {
      return `a ${value.constructor.name} wrapper — keep() it, or track() its getShape()`;
    }
    return typeof value === 'object' ? 'a plain object' : `a ${typeof value}`;
  }
}
