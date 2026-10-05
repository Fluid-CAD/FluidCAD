---
id: api/region
title: region(name, ...entities) / far(entity)
summary: Declares a named region of a sketch by the entities on its outer loop, for a 3D operation's .region(name); far() marks an entity the region lies on the far side of.
tags: [api, 2d, region]
symbols: [region, far]
seeAlso: [api/extrude, api/cut, api/revolve, api/sweep, api/wrap, api/sketch]
---

# region / far

Imported from `fluidcad/core`. Written inside a sketch callback.

```ts
region(name: string, ...entities: IRegionTarget[])   // a named region of the sketch
far(entity: IRegionTarget)                            // the region lies on the entity's far side
```

A sketch whose shapes overlap has several closed regions. `region()` names
one by the sketch entities on its OUTER loop — the variables themselves,
not strings — and an operation on the sketch takes it with `.region(name)`.
Holes never take part: the ring inside `outer` is `region('ring', outer)`
however many circles sit inside it; each hole is a region of its own.

```js
const s = sketch('xy', () => {
  const outer = circle([0, 0], 60);
  const inner = circle([0, 0], 30);
  region('ring', outer);
  region('disc', inner);

  const a = circle([-20, 0], 80);
  const b = circle([20, 0], 80);
  region('lens', a, b);              // inside both
  region('crescent', a, far(b));     // inside a, outside b

  const r = rect([0, 0], 40, 20);
  const l = line([20, -5], [20, 25]);
  region('inside', r);               // a bare rect covers every side on the region
  region('leftHalf', r, l);          // left of l's own direction (it runs +y)
  region('rightHalf', r, far(l));
});
extrude(20, s).region('ring', 'lens');
```

`far(entity)` is the one side marker: the region lies on the right of the
edge's own direction — outside a counter-clockwise circle. It is needed
only where two regions share the same entities (a lens and its crescents,
the halves of a disc a line cuts). The dialog's region picker writes it
automatically.

Entities: any sketch entity statement (`line`, `circle`, `arc`, `rect`,
`project`, `offset`, …), or one edge of a multi-edge statement — `r.top()`,
`r.corner(2)`, `p.ref(2)`, `o.edge(0)`.

A declaration is topological: it survives dimension edits, dragged
geometry, unrelated entities added or removed, and holes cut into the
region. Deleting an entity it names is a compile error at the declaration.
When the entities bound more than one region the consuming feature errors
and lists the candidates with their `far()` markers; when the region's
boundary was redrawn it takes the region keeping most of the declared
boundary, or errors naming the nearest. A `.region()` with no names on the
operation builds nothing and lists every region in the feature's `regions`
parameter, with the name of the declaration describing each.
