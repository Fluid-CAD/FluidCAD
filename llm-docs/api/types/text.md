---
id: api/types/text
title: Text
summary: "The Text type. Extends ExtrudableGeometry; adds 11 methods."
tags: [api, type, interface]
symbols: [Text, IText]
seeAlso: [api/types/extrudable-geometry]
---
# Text

```ts
interface Text extends ExtrudableGeometry {
  size(value: number): this;
  font(name: string): this;
  weight(value: string | number): this;
  bold(): this;
  italic(value?: boolean): this;
  align(value: "left" | "right" | "center" | "start" | "end" | "stretch"): this;
  lineSpacing(value: number): this;
  letterSpacing(value: number): this;
  offset(value: number): this;
  flip(value?: boolean): this;
  startAt(distance: number): this;
}
```

Extends [[api/types/extrudable-geometry]].

## Methods

### `size()`

Sets the text height (em size) in model units. Default 10.

| Parameter | Type | Description |
| --- | --- | --- |
| `value` | `number` | The em size. |

### `font()`

Sets the font. A name without a font extension (e.g. `"Arial"`) is resolved
to a system font; a value ending in `.ttf`/`.otf`/`.ttc`/`.woff` (e.g.
`"fonts/Brand.ttf"`) is loaded as a workspace-relative file. When omitted, a
default system font is used.

| Parameter | Type | Description |
| --- | --- | --- |
| `name` | `string` | A system family name or a workspace-relative font file path. |

### `weight()`

Sets the font weight: a number (100–900) or a name such as `"regular"`,
`"medium"`, or `"bold"`. Resolves to the matching face (or the wght axis of a
variable font).

| Parameter | Type | Description |
| --- | --- | --- |
| `value` | `string` \| `number` | The weight as a number or name. |

### `bold()`

Shortcut for `weight(700)`.

### `italic()`

Renders the italic/oblique face of the font.

| Parameter | Type | Description |
| --- | --- | --- |
| `value` | `boolean` | Whether to use italic (defaults to true). *(optional)* |

### `align()`

Horizontal alignment of the text. For straight text it is relative to the
origin point; for text along a path it positions the run against the
path: `"start"` begins at the path's start, `"center"` centers on the
midpoint, `"end"` finishes at the path's end, and `"stretch"` justifies
the glyphs evenly across the whole path (path text only). `"left"` and
`"right"` are synonyms of `"start"` and `"end"`.

| Parameter | Type | Description |
| --- | --- | --- |
| `value` | `"left"` \| `"right"` \| `"center"` \| `"start"` \| `"end"` \| `"stretch"` | `"left"`/`"start"` (default), `"center"`, `"right"`/`"end"`, or `"stretch"`. |

### `lineSpacing()`

Line-height multiplier for multi-line text (newlines in the string).

| Parameter | Type | Description |
| --- | --- | --- |
| `value` | `number` | Multiplier on the font's natural line height (default 1). |

### `letterSpacing()`

Extra spacing added between glyphs, in model units (default 0).

| Parameter | Type | Description |
| --- | --- | --- |
| `value` | `number` | The additional advance per glyph. |

### `offset()`

Shifts the baseline perpendicular to the path, in model units: positive
values move the text toward its "up" side, negative below the path.
Only applies to text following a path (`text(string, path)`).

| Parameter | Type | Description |
| --- | --- | --- |
| `value` | `number` | The perpendicular baseline shift. |

### `flip()`

Mirrors the text to the other side of the path, reversing the reading
direction. On a closed path (circle, loop) text sits on the outside by
default — `.flip()` moves it inside. On an open path it mirrors the text
below the curve. Only applies to text following a path.

| Parameter | Type | Description |
| --- | --- | --- |
| `value` | `boolean` | Whether to flip (defaults to true). *(optional)* |

### `startAt()`

Shifts where the text starts along the path, as an arc-length distance
from the path's start (combines with `align()`). On a closed path the
text wraps around. Only applies to text following a path.

| Parameter | Type | Description |
| --- | --- | --- |
| `distance` | `number` | The arc-length shift in model units. |

## Inherited

From [[api/types/geometry]]: `guide()`, `start()`, `end()`, `tangent()`

From [[api/types/scene-object]]: `name()`, `reusable()`
