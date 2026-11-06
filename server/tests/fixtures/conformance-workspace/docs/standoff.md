# Standoff

A boss with a bore through it, standing on one planar face: the post a
circuit board screws onto.

![A standoff on a plate](./images/standoff.svg)

## Use

```js
import { standoff } from '@acme/kit';

const post = standoff(pad.endFaces(), { height: 10, outer: 6, hole: 3 });
```

- `height`: how far the boss rises from the face.
- `outer`: the boss diameter; `hole` must be narrower.

The package's [README](../README.md) lists the other features.
