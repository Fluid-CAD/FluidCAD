/**
 * The types a feature's declared values give it: what `Feature.with()`
 * types `this.values` as, and what `defineFeature()` types its builder's
 * arguments as. Plain JavaScript gets them through inference alone:
 *
 * ```js
 * class Standoff extends Feature.with({
 *   face: { picker: 'face', surface: 'planar' },
 *   height: { type: 'length', default: 10 },
 *   size: { type: 'select', options: [{ label: 'M3', value: 'm3' }, { label: 'M4', value: 'm4' }] },
 * }) {
 *   buildTool() {
 *     const { face, height, size } = this.values;   // ISelection, number, 'm3' | 'm4'
 *   }
 * }
 * ```
 */

import type { ISceneObject, ISelection } from "../core/interfaces.js";
import type { Axis, StandardAxis } from "../math/axis.js";
import type { Plane, StandardPlane } from "../math/plane.js";
import type { ParamSpec } from "./meta.js";

/** A feature's values by name, as `Feature.with()` declares them. */
export type FeatureParams = { readonly [name: string]: ParamSpec };

/** A spec whose value is a list: a picker with `multiple: true` or a `max`. */
type ListSpec = { multiple: true } | { max: number };

/** A picked value: a list of `T` for a list picker, one `T` otherwise. */
type Picked<S, T> = S extends ListSpec ? T[] : T;

/** The value a typed-in spec gives the feature. */
type ScalarValueOf<S> =
  S extends { type: 'select'; options: readonly { value: infer V extends string | number }[] } ? V
  : S extends { type: 'boolean' } ? boolean
  : S extends { type: 'text' } ? string
  : S extends { type: 'number' | 'integer' | 'length' | 'angle' } ? number
  : never;

/**
 * The value one spec gives the feature when the call passes it: a number, a
 * boolean, a string, a select's option values, the picked selection of a
 * face or edge picker, the picked scene object of any other picker — a list
 * of them for a list picker.
 */
type PassedValueOf<S> =
  S extends { picker: 'face' | 'edge' } ? Picked<S, ISelection>
  : S extends { picker: string } ? Picked<S, ISceneObject>
  : ScalarValueOf<S>;

/**
 * Whether a call may leave the value out: it has a default, is `optional`,
 * is a list (an empty one then), or is a sketch that defaults to the active
 * one.
 */
type CanLeaveOut<S> =
  S extends { default: string | number | boolean } ? true
  : S extends { optional: true } ? true
  : S extends ListSpec ? true
  : S extends { picker: 'sketch'; implicitDefault: true } ? true
  : false;

/**
 * What a value the call may leave out reaches the feature as when it does:
 * its default when it has one, an empty list for a list — and `undefined`
 * for the rest. Never, for a value the call must pass.
 */
type LeftOut<S> =
  CanLeaveOut<S> extends false ? never
  : S extends { default: string | number | boolean } ? never
  : S extends ListSpec ? never
  : undefined;

/**
 * The value one spec gives the feature, as `this.values` holds it: what a
 * call passes for it, or `undefined` for an optional value without a
 * default that the call left out.
 */
export type ValueOf<S> = PassedValueOf<S> | LeftOut<S>;

/**
 * The values a feature's specs give it, by name — the type of `this.values`
 * in a class that extends `Feature.with(params)`. (Each is spelled out here
 * rather than as `ValueOf<P[K]>`, so an editor shows `number | undefined`
 * rather than the alias.)
 */
export type ValuesOf<P> = { readonly [K in keyof P]: PassedValueOf<P[K]> | LeftOut<P[K]> };

/** Every value a list picker declares, by name: those a call shape may spread (`'...faces'`). */
type ListNames<P> = { [K in keyof P]: P[K] extends ListSpec ? K : never }[keyof P] & string;

/**
 * A call shape over the values `P` declares: each slot names one of them, so
 * a misspelled name is an error in the editor.
 */
export type FeatureCallShape<P> = readonly (
  | (keyof P & string)
  | `...${ListNames<P>}`
  | { readonly [option: string]: keyof P & string }
)[];

/** What a builder's call may pass for one value: what the value is, or what the builder turns into it. */
type ArgOf<S> =
  S extends { picker: 'face' | 'edge' } ? (S extends ListSpec ? ISelection | ISelection[] : ISelection)
  : S extends { picker: 'axis' } ? ISceneObject | StandardAxis | Axis
  : S extends { picker: 'plane' } ? ISceneObject | StandardPlane | Plane
  : S extends { picker: string } ? (S extends ListSpec ? ISceneObject | ISceneObject[] : ISceneObject)
  : ScalarValueOf<S>;

/** One element of a spread rest value. */
type RestArgOf<S> = S extends { picker: 'face' | 'edge' } ? ISelection : ISceneObject;

/** `T` flattened into one object type, so an editor shows its keys rather than an intersection. */
type Flat<T> = { [K in keyof T]: T[K] } & {};

/**
 * The object of options a call passes, the options it must hold first: an
 * option whose value may be left out is optional.
 */
type OptionsArg<P, O> = Flat<
  { -readonly [K in keyof O as O[K] extends keyof P ? (CanLeaveOut<P[O[K]]> extends true ? never : K) : never]: O[K] extends keyof P ? ArgOf<P[O[K]]> : never }
  & { -readonly [K in keyof O as O[K] extends keyof P ? (CanLeaveOut<P[O[K]]> extends true ? K : never) : never]?: O[K] extends keyof P ? ArgOf<P[O[K]]> : never }
>;

/** Whether a call may leave the whole object of options out: every option in it may be left out. */
type OptionsCanLeaveOut<P, O> = {} extends OptionsArg<P, O> ? true : false;

/**
 * One argument ahead of `Tail`: optional when it may be left out and every
 * argument after it may too; one left out ahead of a later one is passed as
 * `undefined`.
 */
type Argument<A, CanOmit, Tail extends unknown[]> =
  CanOmit extends true
    ? ([] extends Tail ? [A?, ...Tail] : [A | undefined, ...Tail])
    : [A, ...Tail];

/**
 * The arguments of a builder's call, by its call shape `S` over the values
 * `P`: positional values, the object of options, the spread rest value. A
 * shape that is not a literal list (one the editor already marks wrong)
 * types them as `unknown[]`, so its calls aren't marked wrong too.
 */
export type FeatureArgs<P, S> =
  S extends readonly [infer Slot, ...infer Rest]
    ? Slot extends `...${infer N extends keyof P & string}` ? RestArgOf<P[N]>[]
    : Slot extends keyof P ? Argument<ArgOf<P[Slot]>, CanLeaveOut<P[Slot]>, FeatureArgs<P, Rest>>
    : Argument<OptionsArg<P, Slot>, OptionsCanLeaveOut<P, Slot>, FeatureArgs<P, Rest>>
    : S extends readonly [] ? []
    : unknown[];
