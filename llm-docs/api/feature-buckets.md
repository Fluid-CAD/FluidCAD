---
id: api/feature-buckets
title: "Named buckets — Feature.with(params, { buckets }): a custom feature's own faces and edges"
summary: "A custom feature declares buckets of its own in Feature.with()'s second argument, { buckets: { tipFaces: {}, tipEdges: {}, boreEdges: { label: 'Bore Rims' } } }, and fills them in setBuckets(). Each name ends in Faces or Edges, which says what it holds, and becomes a typed method read like endFaces() (g.tipEdges(), r.instance(k).tipEdges()). A declaration holds only a label (a description is refused: the package's docs/ pages say what a bucket holds); a standard name is declared only to relabel it; edge buckets are opt-in, and a declared xEdges left unfilled is the edges of xFaces. Every refusal (where the module loads, and in setBuckets()), what a fusion, a remove and a repeat's copy do to the buckets, why a fused gear's tip fillet fails, the editor's picks and menus, and static buckets on a plain subclass."
tags: [api, sdk, custom-feature, buckets, type]
symbols: [FeatureWithOptions, FeatureBucketSpecs, FeatureBucketSpec]
seeAlso: [api/feature, concepts/custom-features, api/feature-example-gear, api/feature-example-bearing-seat, api/register-builder, api/repeat]
---

# Named buckets

Declared on the class that extends `Feature.with()` from `fluidcad/sdk` (the
class, the standard buckets and `setBuckets()`: [[api/feature]]).

```ts
// Feature.with(params, options)'s second argument:
type FeatureWithOptions = { buckets?: FeatureBucketSpecs };
type FeatureBucketSpecs = { [name: string]: FeatureBucketSpec };   // name: /^[a-z][A-Za-z0-9]*(Faces|Edges)$/
type FeatureBucketSpec = { label?: string };                        // the menus' words; nothing else

// Each declared name that is not a standard one becomes a method of the feature,
// taking indices and filters as endFaces() does:
g.tipFaces(...indicesOrFaceFilters): ISelection
g.tipEdges(...indicesOrEdgeFilters): ISelection
r.instance(k).tipEdges(...)          // on a repeat's copy
// and a key of setBuckets(): this.setBuckets({ tipFaces: Face[], tipEdges: Edge[] })
```

The standard buckets say where a face sits the way an extrude's do. When the
feature's result has parts with names of their own (a gear's tooth tips, a
pocket's floor), declare them, and each becomes a method a model calls like
`endFaces()`. Declare the buckets a user will fillet, chamfer or sketch on:

```js
export class Gear extends Feature.with({ /* … values … */ }, {
  buckets: {
    tipFaces: {},                       // the top land of every tooth, in tooth order
    tipEdges: {},                       // declared, not filled: the edges of tipFaces
    flankFaces: {},                     // two per tooth, in tooth order
    boreFaces: {},                      // the wall of the shaft hole
    boreEdges: { label: 'Bore Rims' },  // the menus read "Gear Bore Rims"
  },
}) {
  static id = 'gear';

  buildTool() {
    // … build the solid, sort its faces, place it …
    this.setBuckets({ startFaces, endFaces, sideFaces, tipFaces, flankFaces, boreFaces });
    return [solid];
  }
}

// In a model:
const g = gear(seat.endFaces(), { teeth: 18 }).new();
fillet(0.3, g.tipEdges());                // every tooth tip
chamfer(0.5, g.boreEdges(0));             // indices and filters, as endEdges() takes them
```

## Declaring

- **The name is the accessor, and its ending is what it holds**: a
  `…Faces` bucket holds faces, an `…Edges` bucket edges. A lowercase letter,
  then letters and digits, ending in `Faces` or `Edges` with a name before
  it (`/^[a-z][A-Za-z0-9]*(Faces|Edges)$/`), at most 48 characters; at most
  32 buckets a class.
- **A declaration is `{}` or `{ label }`.** `label` is what the editor's
  menus call the bucket; left out, the name made readable (`tipEdges` →
  "Tip Edges"). The menus put the feature's label first: "Gear Tip Edges",
  "Gear Bore Rims". There is no `description`: say what each bucket holds,
  and in what order, in the package's `docs/` page for the feature
  (`docs/gear.md`), which other authors and the LLM read. A line comment
  beside the declaration is for whoever reads the code.
- **A standard name** is declared only to relabel it: `endFaces: { label:
  'Top Face' }` makes no new method.
- **Edge buckets are opt-in.** `g.tipEdges()` exists because `tipEdges` is
  declared; `g.flankEdges()` doesn't. A declared `xEdges` that `setBuckets()`
  leaves out is the distinct edges of `xFaces`, taken after the fusion or the
  cut. Fill an edge bucket explicitly when it is not every edge of a face
  bucket (a pocket's vertical corner edges).
- **Typed under checkJs.** `g.tipEdges()` is an `ISelection`, and
  `g.tipEdge()` is an editor error ("Property 'tipEdge' does not exist on
  type 'Gear'. Did you mean 'tipEdges'?"), as is a misspelt name in
  `setBuckets()`. A repeat of one gear types `r.instance(k).tipEdges()`.
- **A plain subclass** (the [[api/register-builder]] path) declares
  `static buckets = { boreFaces: {}, boreEdges: {} }`: the same checks and
  the same methods at run time, but no types. `Feature.with()` is the typed
  path.
- **`buckets` in the metadata is refused**: `defineFeature(Gear): leave
  'buckets' out — declare buckets on the class: Feature.with(params, {
  buckets })` (`registerBuilder`'s own message: [[api/register-builder]]).

## Refused where the module loads

`Feature.with()` checks the declaration (`registerBuilder` does for a plain
subclass, its messages leading with `feature '<id>'` instead): the model
importing the module fails to compile and its Custom cell greys, with one of:

| Declared | Refused with |
|---|---|
| a name without the ending | `Feature.with(): 'teeth' needs to end in Faces or Edges (teethFaces?)` |
| the ending alone | `Feature.with(): 'Faces' needs a name before Faces, such as tipFaces` |
| a name over 48 characters | `Feature.with(): the bucket name '…Faces' is longer than 48 characters` |
| a declaration that is not an object | `Feature.with(): bucket 'tipFaces' is declared with an object — {} or { label } — got 'The tips'` |
| a description | `Feature.with(): bucket 'tipFaces': leave 'description' out — describe what the feature's buckets hold in the package's docs/ pages` |
| a kind | `Feature.with(): bucket 'tipFaces': leave 'kind' out — the name's ending gives it: a …Faces bucket holds faces, an …Edges bucket edges` |
| any other field | `Feature.with(): bucket 'tipFaces': unknown field 'note' — a bucket declares only its label` |
| an empty label | `Feature.with(): bucket 'tipFaces': 'label' must be text that says something, got ' '` |
| a name every feature already has | `Feature.with(): 'getAddedFaces' is already a member of SceneObject — give the bucket another name` |
| a method of the same name written on the class | `feature 'gear': Gear writes tipFaces() itself — the declared bucket makes that accessor; remove the method or rename the bucket` |
| more than 32 | `Feature.with(): declares 33 buckets — a feature declares at most 32` |
| an option other than `buckets` | `Feature.with(): unknown option 'bucket' — the options are: buckets` |

## Refused by `setBuckets()`

As the row's build error, for standard and declared names alike (the
dialog's preview shows the same message; `render()` never throws):

| `setBuckets()` was handed | The row's error |
|---|---|
| a name that is no bucket of the feature | `gear: setBuckets() 'tipFace' is not a bucket of gear — did you mean tipFaces?` (with no name close, it lists the feature's buckets) |
| a value that is not a list | `gear: setBuckets() tipFaces must be a list of faces, got a face` |
| a member of the wrong kind | `gear: setBuckets() tipFaces[0] is an edge, not a face — tipFaces holds faces` |
| a tool's member that is no face or edge of the solids `buildTool()` returned (a face of the shape before `transformTracking` placed it) | `gear: setBuckets() boreFaces[1] is not a face of the solids buildTool() returned — name faces of the shapes you return` |
| a `startPlane` that is not a `Plane` | `gear: setBuckets() startPlane must be a plane, got 'xy'` |
| anything but an object of buckets by name | `gear: setBuckets() takes the buckets by name, such as { endFaces: [face] } — got a list` |

So a misspelt bucket fails where it is filled, not later as an empty bucket
that a fillet finds nothing in.

## What a named bucket holds after the operation

| The statement | Its named buckets |
|---|---|
| `.add()` | Each member followed through the fusion, keeping only what the final solid carries: a face the stock swallowed is dropped, a face the stock cut short is the piece that is left. Nothing is re-homed: a face that merges into the stock leaves the bucket. (`startFaces` and `endFaces` are re-homed onto the stock face they merged into, so name the face a feature grows from `startFaces`, not a bucket of your own.) |
| `.new()` | The members as built. |
| `.remove()` | Each member becomes what the cut left of it: a pocket's `floorFaces` is the floor the cut made, faced out of the material, and its derived `floorEdges` the floor's rim. A member the cut removes entirely is dropped, so a pocket that goes right through has no floor and `p.floorFaces()` is empty. The standard buckets are the cut's own classification (see `startPlane` in [[api/feature]]). |
| a `repeat()` copy | Its own members, moved with it: `r.instance(2).tipEdges()` reads copy 2's (when the slot holds that one feature; with several, the accessor says it is ambiguous). On a mirror, `m.instance(1).tipFaces(i)` is the mirror image of `g.tipFaces(i)`. |
| a modifier | Its final geometry, at once. |

**A fused feature's derived edges.** A gear fused into a plate keeps in
`g.tipEdges()` the concave edges where each tip meets the plate, and
OpenCascade can't round those together with the convex tip edges at the
same corner: there `fillet(0.3, g.tipEdges())` fails. Filter them
(`g.tipEdges(edge().convex())`) or keep the gear apart (`.new()`).

## In the editor

A pick on the feature's geometry is written through its named buckets first,
in declaration order, then the standard ones: a click on a tooth's tip edge
writes `g.tipEdges(…)` (a filter, or an index among its alternatives), never
`g.endEdges(7)`, and a set of picks that exactly fills one bucket is written
as the whole bucket (`g.tipFaces()`; every side face of the gear,
`g.sideFaces()`). Right-clicking a pick offers "Gear Tip Edges (72)", with
the feature's other buckets under *Select other*; the hover reads "tip edges
of Gear"; a pick on a repeat's copy writes `r.instance(1).tipEdges(…)`.

## Examples

- [[api/feature-example-gear]]: a spur gear that fills `tipFaces`,
  `flankFaces`, `rootFaces` and `boreFaces`, derives `tipEdges` and
  `boreEdges`, and a gear pair rounded through them.
- [[api/feature-example-bearing-seat]]: a pocket whose `floorFaces`,
  `floorEdges` and `wallFaces` are what its cut leaves.
