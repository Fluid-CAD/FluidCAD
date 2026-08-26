---
id: api/types/reference-entity
title: ReferenceEntity
summary: "One projected/sectioned edge as a constraint target (P6 fixed reference): `p.ref(0)` names the edge, its accessors name its points."
tags: [api, type, interface]
symbols: [ReferenceEntity, IReferenceEntity]
seeAlso: [api/project-intersect]
---
# ReferenceEntity

```ts
interface ReferenceEntity {
  start(): Vertex;
  end(): Vertex;
  center(): Vertex;
}
```

One projected/sectioned edge as a constraint target (P6 fixed reference):
`p.ref(0)` names the edge, its accessors name its points.

## Methods

### `start()`

**Returns**: [[api/types/vertex]].

### `end()`

**Returns**: [[api/types/vertex]].

### `center()`

**Returns**: [[api/types/vertex]].
