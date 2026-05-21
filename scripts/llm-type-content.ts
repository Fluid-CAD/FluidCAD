// Hand-curated content for the type aliases that don't have meaningful method
// surfaces — union aliases, string-literal aliases, and options bags. Consumed
// by `scripts/build-llm-type-docs.ts` to assemble llm-docs markdown.
//
// Interface types (SceneObject, Extrude, ...) get their content extracted from
// TypeScript source via ts-morph in the generator; they do not appear here.

export type AcceptedForm = {
  /** Display label (column 1). May include backticks for code. */
  format: string;
  /** Example value (column 2). May include backticks. */
  example: string;
  /** Plain-text description (column 3). */
  description: string;
  /** Optional doc id for the format (e.g. "api/types/plane") — emits a [[link]]. */
  link?: string;
};

export type UnionAliasContent = {
  summary: string;
  intro: string;
  acceptedForms: AcceptedForm[];
  example?: string;
  trailingNotes?: string;
};

export type OptionsContent = {
  summary: string;
  description: string;
};

export const unionAliases: Record<string, UnionAliasContent> = {
  PlaneLike: {
    summary:
      'A plane reference accepted by sketch(), filters, and other plane-aware operations.',
    intro:
      'A plane reference used by `sketch()`, filters, and other operations. Any of the following formats are accepted:',
    acceptedForms: [
      {
        format: 'Standard plane string',
        example: '`"xy"`, `"xz"`, `"yz"`',
        description: 'The three principal planes.',
      },
      {
        format: 'Negative plane string',
        example: '`"-xy"`, `"-xz"`, `"-yz"`',
        description: 'Principal planes with flipped normals.',
      },
      {
        format: 'Named plane string',
        example: '`"top"`, `"bottom"`, `"front"`, `"back"`, `"left"`, `"right"`',
        description: 'Descriptive aliases for the principal planes.',
      },
      {
        format: '`Plane`',
        example: '`plane("xy", 10)`',
        description: 'A plane object created with `plane()`.',
        link: 'api/types/plane',
      },
      {
        format: '`SceneObject`',
        example: 'A face selection',
        description: 'A planar face to use as reference.',
        link: 'api/types/scene-object',
      },
    ],
    example: `import { sketch, rect, circle, extrude, plane } from "fluidcad/core";

sketch("xy", () => rect(100, 50).centered());            // string form
const e = extrude(20);
sketch(plane("xy", 30), () => rect(40, 40).centered());  // Plane form
sketch(e.endFaces(), () => circle(10));                  // face form
extrude(5);
`,
  },

  AxisLike: {
    summary:
      'An axis reference accepted by revolve(), repeat(), and other axis-based operations.',
    intro:
      'An axis reference used by `revolve()` and other axis-based operations. Any of the following formats are accepted:',
    acceptedForms: [
      {
        format: 'Standard axis string',
        example: '`"x"`, `"y"`, `"z"`',
        description: 'The three principal axes.',
      },
      {
        format: '`Axis`',
        example: '`axis("x", [0, 10])`',
        description: 'An axis object created with `axis()`.',
        link: 'api/types/axis',
      },
    ],
    example: `import { sketch, rect, move, revolve, axis } from "fluidcad/core";

sketch("xz", () => {
  move([20, 0]);
  rect(10, 30);
});
revolve("z", 360);             // string form

sketch("xz", () => {
  move([30, 0]);
  rect(5, 5);
});
revolve(axis("z"), 180);       // Axis form
`,
  },

  PointLike: {
    summary: 'A 3D point accepted by translate() and other 3D operations.',
    intro:
      'A 3D point used by operations like `translate()`. Any of the following formats are accepted:',
    acceptedForms: [
      {
        format: '`[number, number, number]`',
        example: '`[10, 20, 30]`',
        description: 'Tuple of x, y, z coordinates.',
      },
      {
        format: '`{ x, y, z }`',
        example: '`{ x: 10, y: 20, z: 30 }`',
        description: 'Object with x, y, z properties.',
      },
    ],
  },

  Point2DLike: {
    summary: 'A 2D point accepted by sketching functions.',
    intro:
      'A 2D point used by all sketching functions. Any of the following formats are accepted:',
    acceptedForms: [
      {
        format: '`[number, number]`',
        example: '`[10, 20]`',
        description: 'Tuple of x, y coordinates.',
      },
      {
        format: '`number[]`',
        example: '`[10, 20]`',
        description: 'Array of x, y coordinates.',
      },
      {
        format: '`{ x, y }`',
        example: '`{ x: 10, y: 20 }`',
        description: 'Object with x, y properties.',
      },
      {
        format: '`Vertex`',
        example: '`line(...).end()`',
        description: 'A vertex returned by a geometry method.',
        link: 'api/types/vertex',
      },
    ],
  },

  Vertex: {
    summary: 'A lazy-evaluated vertex representing a point on existing geometry.',
    intro:
      'A lazy-evaluated vertex representing a point on geometry. Vertices are returned by methods like `start()`, `end()`, and `tangent()` on `Geometry` types.',
    acceptedForms: [],
    trailingNotes:
      'Vertices can be passed as a [[api/types/point2dlike]] to any function that accepts a 2D point, allowing you to reference points on existing geometry.',
  },
};

export const optionsBags: Record<string, OptionsContent> = {
  LinearRepeatOptions: {
    summary: 'Options for `repeat("linear", ...)`.',
    description:
      'Options accepted by the linear variant of `repeat()`. Controls how many copies are placed and how they are spaced along the chosen axes.',
  },
  CircularRepeatOptions: {
    summary: 'Options for `repeat("circular", ...)`.',
    description:
      'Options accepted by the circular variant of `repeat()`. Controls how many copies are placed and how they sweep around the chosen axis.',
  },
  PlaneTransformOptions: {
    summary:
      'Options accepted by `plane()` for offsetting and rotating a plane in its own frame.',
    description:
      'Options accepted by `plane()` to offset and rotate a plane relative to its own axes. Rotations are composed together and applied around the plane\'s origin (after the offset is applied), so the plane tilts in place rather than orbiting the world origin.',
  },
};
