import {
  FeatureEntry, TypeEntry, FilterEntry,
  resolveTypeName, typeSlug, hasTypePage, getInheritanceChain,
  optionsTypeProperties, OptionsProperty,
} from './api-doc-config.ts';

export interface SignatureInfo {
  description: string;
  params: ParamInfo[];
  returnType: string;
  isPlaneVariant: boolean;
}

export interface ParamInfo {
  name: string;
  type: string;
  description: string;
  optional: boolean;
}

export interface MethodInfo {
  name: string;
  description: string;
  params: ParamInfo[];
  returnType: string;
  signatures: string[];
}

export interface ExampleFile {
  importName: string;
  relativePath: string;
  screenshotPath?: string;
}

function escapeForTable(text: string): string {
  return cleanDescription(text).replace(/\|/g, '\\|').replace(/\n/g, ' ').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cleanDescription(text: string): string {
  // Strip leading "- " from @param descriptions
  let cleaned = text.replace(/^-\s+/, '');
  // Resolve {@link Foo} to just Foo
  cleaned = cleaned.replace(/\{@link\s+([^}]+)\}/g, '$1');
  return cleaned;
}

function escapeAngleBrackets(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatParamType(raw: string): string {
  // Inline object types: wrap in code backticks and escape for MDX
  if (raw.includes('{')) {
    return '`' + raw + '`';
  }

  // Handle union types like "number | FaceFilterBuilder"
  if (raw.includes('|')) {
    const parts = raw.split('|').map(p => p.trim());
    return parts.map(p => {
      const display = resolveTypeName(p);
      if (hasTypePage(p)) {
        return `[${escapeAngleBrackets(display)}](/docs/api/types/${typeSlug(display)})`;
      }
      return escapeAngleBrackets(display);
    }).join(' \\| ');
  }

  // Handle array types like "(number | FaceFilterBuilder)[]"
  const parenArrayMatch = raw.match(/^\((.+)\)\[\]$/);
  if (parenArrayMatch) {
    return `(${formatParamType(parenArrayMatch[1])})[]`;
  }

  // Handle simple array types like "ISceneObject[]"
  const simpleArrayMatch = raw.match(/^(.+)\[\]$/);
  if (simpleArrayMatch) {
    return `${formatParamType(simpleArrayMatch[1])}[]`;
  }

  const display = resolveTypeName(raw);
  if (hasTypePage(raw)) {
    return `[${escapeAngleBrackets(display)}](/docs/api/types/${typeSlug(display)})`;
  }
  return escapeAngleBrackets(display);
}

function renderSignatureCode(name: string, sig: SignatureInfo): string {
  const params = sig.params.map(p => {
    const opt = p.optional ? '?' : '';
    const displayType = resolveTypeName(p.type);
    if (p.name.startsWith('...')) {
      // Rest param type already includes [], don't double it
      return `${p.name}: ${displayType}`;
    }
    return `${p.name}${opt}: ${displayType}`;
  }).join(', ');

  const retDisplay = resolveTypeName(sig.returnType);
  return `${name}(${params}): ${retDisplay}`;
}

function renderParamsTable(params: ParamInfo[]): string {
  if (params.length === 0) {
    return '';
  }

  const rows = params.map(p => {
    const name = p.name.startsWith('...') ? p.name : p.name;
    const opt = p.optional ? ' *(optional)*' : '';
    const desc = escapeForTable(p.description) + opt;
    const typeDisplay = formatParamType(p.type);
    return `| \`${name}\` | ${typeDisplay} | ${desc} |`;
  });

  return [
    '| Parameter | Type | Description |',
    '|-----------|------|-------------|',
    ...rows,
  ].join('\n');
}

function renderOptionsTable(properties: OptionsProperty[]): string {
  const rows = properties.map(p => {
    const opt = p.optional ? ' *(optional)*' : '';
    const desc = escapeForTable(p.description) + opt;
    const typeDisplay = formatParamType(p.type);
    return `| \`${p.name}\` | ${typeDisplay} | ${desc} |`;
  });

  return [
    '| Property | Type | Description |',
    '|----------|------|-------------|',
    ...rows,
  ].join('\n');
}

// ── Feature Page ──

export function renderFeaturePage(
  feature: FeatureEntry,
  signatures: SignatureInfo[],
  examples: ExampleFile[],
  sidebarPositionOverride?: number,
): string {
  const nonPlaneSignatures = signatures.filter(s => !s.isPlaneVariant);
  const hasPlaneVariants = signatures.some(s => s.isPlaneVariant);

  // Use first signature's description as page intro
  const introDesc = nonPlaneSignatures[0]?.description || signatures[0]?.description || '';

  const returnLink = feature.returnType.includes(' | ')
    ? feature.returnType.split(' | ').map(part => {
        const display = resolveTypeName(part.trim());
        return hasTypePage(part.trim())
          ? `[**\`${display}\`**](/docs/api/types/${typeSlug(display)})`
          : `**\`${display}\`**`;
      }).join(' \\| ')
    : (() => {
        const returnDisplay = resolveTypeName(feature.returnType);
        return hasTypePage(feature.returnType)
          ? `[**\`${returnDisplay}\`**](/docs/api/types/${typeSlug(returnDisplay)})`
          : `**\`${returnDisplay}\`**`;
      })();

  const lines: string[] = [];

  // Frontmatter
  lines.push('---');
  lines.push(`sidebar_position: ${sidebarPositionOverride ?? feature.sidebarPosition}`);
  lines.push(`title: "${feature.displayName}"`);
  if (introDesc) {
    lines.push(`description: "${escapeForTable(introDesc)}"`);
  }
  lines.push('---');
  lines.push('');

  // Imports for examples
  for (const ex of examples) {
    lines.push(`import ${ex.importName} from '!!raw-loader!${ex.relativePath}';`);
  }
  if (examples.length > 0) {
    lines.push(`import CodeBlock from '@theme/CodeBlock';`);
    lines.push('');
  }

  // Title
  lines.push(`# ${feature.displayName}()`);
  lines.push('');

  if (introDesc) {
    lines.push(introDesc);
    lines.push('');
  }

  if (feature.returnType !== 'void') {
    lines.push(`**Returns**: ${returnLink}`);
    lines.push('');
  }

  // Related guide link
  if (feature.relatedGuide) {
    lines.push(':::tip');
    lines.push(`See the [guide](${feature.relatedGuide}) for detailed usage examples.`);
    lines.push(':::');
    lines.push('');
  }

  // Signatures
  lines.push('## Signatures');
  lines.push('');

  const renderedOptionsTypes = new Set<string>();

  for (let i = 0; i < nonPlaneSignatures.length; i++) {
    const sig = nonPlaneSignatures[i];
    lines.push('```ts');
    lines.push(renderSignatureCode(feature.displayName, sig));
    lines.push('```');
    lines.push('');

    if (sig.description) {
      lines.push(sig.description);
      lines.push('');
    }

    const table = renderParamsTable(sig.params);
    if (table) {
      lines.push(table);
      lines.push('');
    }

    // Expand options types into property tables (once per type)
    for (const p of sig.params) {
      const props = optionsTypeProperties[p.type];
      if (props && !renderedOptionsTypes.has(p.type)) {
        // Defer if the next signature also uses this same type
        const nextSig = nonPlaneSignatures[i + 1];
        if (nextSig?.params.some(np => np.type === p.type)) {
          continue;
        }
        renderedOptionsTypes.add(p.type);
        lines.push(`#### ${p.type}`);
        lines.push('');
        lines.push(renderOptionsTable(props));
        lines.push('');
      }
    }

    if (i < nonPlaneSignatures.length - 1) {
      lines.push('---');
      lines.push('');
    }
  }

  if (hasPlaneVariants) {
    lines.push('');
    lines.push(':::note');
    lines.push('All signatures also accept an optional `targetPlane` parameter as the last argument to draw on a specific plane.');
    lines.push(':::');
    lines.push('');
  }

  // Examples
  if (examples.length > 0) {
    lines.push('## Examples');
    lines.push('');

    for (const ex of examples) {
      lines.push(`<CodeBlock language="js">{${ex.importName}}</CodeBlock>`);
      lines.push('');
      if (ex.screenshotPath) {
        lines.push(`![${feature.displayName} example](${ex.screenshotPath})`);
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

// ── Type Page ──

export interface InheritedMethodGroup {
  parentType: TypeEntry;
  methods: MethodInfo[];
}

export function renderTypePage(
  type: TypeEntry,
  methods: MethodInfo[],
  inheritedGroups: InheritedMethodGroup[],
): string {
  const lines: string[] = [];

  // Frontmatter
  lines.push('---');
  lines.push(`sidebar_position: ${type.sidebarPosition}`);
  lines.push(`title: "${type.displayName}"`);
  const extendsDesc = type.extendsType ? ` Extends ${resolveTypeName(type.extendsType)}.` : '';
  lines.push(`description: "The ${type.displayName} type.${extendsDesc}"`);
  lines.push('---');
  lines.push('');

  // Title
  lines.push(`# ${type.displayName}`);
  lines.push('');

  // Extends
  if (type.extendsType) {
    const parentDisplay = resolveTypeName(type.extendsType);
    if (hasTypePage(type.extendsType)) {
      lines.push(`Extends [\`${parentDisplay}\`](/docs/api/types/${typeSlug(parentDisplay)})`);
    } else {
      lines.push(`Extends \`${parentDisplay}\``);
    }
    lines.push('');
  }

  // Inherited methods in collapsible sections (before own methods)
  for (const group of inheritedGroups) {
    if (group.methods.length === 0) {
      continue;
    }
    const parentDisplay = group.parentType.displayName;
    const parentLink = hasTypePage(group.parentType.name)
      ? `[\`${parentDisplay}\`](/docs/api/types/${typeSlug(parentDisplay)})`
      : `\`${parentDisplay}\``;

    lines.push('');
    lines.push(`<details>`);
    lines.push(`<summary>Inherited from ${parentLink}</summary>`);
    lines.push('');
    renderMethodsList(lines, group.methods);
    lines.push('</details>');
    lines.push('');
  }

  // Own methods
  if (methods.length > 0) {
    lines.push('## Methods');
    lines.push('');
    renderMethodsList(lines, methods);
  }

  if (methods.length === 0 && inheritedGroups.every(g => g.methods.length === 0)) {
    lines.push('*This type has no methods.*');
    lines.push('');
  }

  return lines.join('\n');
}

function renderMethodsList(lines: string[], methods: MethodInfo[]) {
  for (const method of methods) {
    lines.push(`### ${method.name}()`);
    lines.push('');

    for (const sig of method.signatures) {
      lines.push('```ts');
      lines.push(sig);
      lines.push('```');
      lines.push('');
    }

    if (method.description) {
      lines.push(method.description);
      lines.push('');
    }

    // Return type line (skip for 'this' since it's the same type)
    if (method.returnType && method.returnType !== 'this') {
      const retDisplay = resolveTypeName(method.returnType);
      if (hasTypePage(method.returnType)) {
        lines.push(`**Returns**: [\`${retDisplay}\`](/docs/api/types/${typeSlug(retDisplay)})`);
      } else {
        lines.push(`**Returns**: \`${retDisplay}\``);
      }
      lines.push('');
    }

    const table = renderParamsTable(method.params);
    if (table) {
      lines.push(table);
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  // Remove trailing ---
  if (lines[lines.length - 2] === '---') {
    lines.splice(lines.length - 2, 1);
  }
}

// ── Filter Page ──

export function renderFilterPage(
  filter: FilterEntry,
  methods: MethodInfo[],
): string {
  const lines: string[] = [];

  // Frontmatter
  lines.push('---');
  lines.push(`sidebar_position: ${filter.sidebarPosition}`);
  lines.push(`title: "${filter.displayName}"`);
  lines.push(`description: "${filter.factoryDescription}"`);
  lines.push('---');
  lines.push('');

  // Title
  lines.push(`# ${filter.displayName}`);
  lines.push('');
  lines.push(filter.factoryDescription);
  lines.push('');

  // Import example
  lines.push('```ts');
  lines.push(`import { ${filter.factoryName} } from 'fluidcad/filters';`);
  lines.push('```');
  lines.push('');

  // Methods
  lines.push('## Methods');
  lines.push('');

  // Group methods: pair each method with its "not" variant
  const methodMap = new Map<string, MethodInfo>();
  for (const m of methods) {
    methodMap.set(m.name, m);
  }

  const processed = new Set<string>();
  for (const method of methods) {
    if (processed.has(method.name)) {
      continue;
    }

    const isNotVariant = method.name.startsWith('not')
      && method.name[3] === method.name[3]?.toUpperCase();

    if (isNotVariant) {
      // Skip — will be rendered alongside the positive variant
      continue;
    }

    processed.add(method.name);

    // Render positive variant
    lines.push(`### .${method.name}()`);
    lines.push('');

    for (const sig of method.signatures) {
      lines.push('```ts');
      lines.push(sig);
      lines.push('```');
      lines.push('');
    }

    if (method.description) {
      lines.push(method.description);
      lines.push('');
    }

    const table = renderParamsTable(method.params);
    if (table) {
      lines.push(table);
      lines.push('');
    }

    // Find and render "not" variant
    const notName = 'not' + method.name.charAt(0).toUpperCase() + method.name.slice(1);
    const notVariant = methodMap.get(notName);
    if (notVariant) {
      processed.add(notName);
      lines.push(`### .${notName}()`);
      lines.push('');

      for (const sig of notVariant.signatures) {
        lines.push('```ts');
        lines.push(sig);
        lines.push('```');
        lines.push('');
      }

      if (notVariant.description) {
        lines.push(notVariant.description);
        lines.push('');
      }

      const notTable = renderParamsTable(notVariant.params);
      if (notTable) {
        lines.push(notTable);
        lines.push('');
      }
    }

    lines.push('---');
    lines.push('');
  }

  // Also render any remaining "not" variants not paired
  for (const method of methods) {
    if (!processed.has(method.name)) {
      processed.add(method.name);
      lines.push(`### .${method.name}()`);
      lines.push('');

      for (const sig of method.signatures) {
        lines.push('```ts');
        lines.push(sig);
        lines.push('```');
        lines.push('');
      }

      if (method.description) {
        lines.push(method.description);
        lines.push('');
      }

      const table = renderParamsTable(method.params);
      if (table) {
        lines.push(table);
        lines.push('');
      }

      lines.push('---');
      lines.push('');
    }
  }

  // Remove trailing ---
  if (lines[lines.length - 2] === '---') {
    lines.splice(lines.length - 2, 1);
  }

  return lines.join('\n');
}

// ── Constraints Page ──

export interface ConstraintInfo {
  name: string;
  description: string;
  params: ParamInfo[];
  returnType: string;
}

export function renderConstraintsPage(
  constraintInfos: ConstraintInfo[],
): string {
  const lines: string[] = [];

  lines.push('---');
  lines.push('sidebar_position: 4');
  lines.push('title: "Constraints"');
  lines.push('description: "Constraint qualifiers for constraining geometry relationships in 2D sketches."');
  lines.push('---');
  lines.push('');

  lines.push('# Constraints');
  lines.push('');
  lines.push('Constraint qualifiers control the spatial relationship between geometries in 2D sketches.');
  lines.push('They are used with tangent geometry functions like `tLine()`, `tCircle()`, and `tArc()`.');
  lines.push('');

  lines.push('```ts');
  lines.push(`import { outside, enclosed, enclosing, unqualified } from 'fluidcad/constraints';`);
  lines.push('```');
  lines.push('');

  lines.push('## Functions');
  lines.push('');

  for (const c of constraintInfos) {
    lines.push(`### ${c.name}()`);
    lines.push('');

    const retDisplay = resolveTypeName(c.returnType);
    const paramStr = c.params.map(p => `${p.name}: ${resolveTypeName(p.type)}`).join(', ');
    lines.push('```ts');
    lines.push(`${c.name}(${paramStr}): ${retDisplay}`);
    lines.push('```');
    lines.push('');

    if (c.description) {
      lines.push(c.description);
      lines.push('');
    }

    const table = renderParamsTable(c.params);
    if (table) {
      lines.push(table);
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  // Remove trailing ---
  if (lines[lines.length - 2] === '---') {
    lines.splice(lines.length - 2, 1);
  }

  return lines.join('\n');
}

// ── Index Page ──

export function renderIndexPage(): string {
  const lines: string[] = [];

  lines.push('---');
  lines.push('sidebar_position: 0');
  lines.push('title: "API Reference"');
  lines.push('description: "FluidCAD API Reference - complete documentation for all features, types, and filters."');
  lines.push('slug: "/api"');
  lines.push('---');
  lines.push('');
  lines.push('# API Reference');
  lines.push('');
  lines.push('Complete API documentation for FluidCAD.');
  lines.push('');
  lines.push('## Features');
  lines.push('');
  lines.push('Functions for creating and manipulating geometry.');
  lines.push('');
  lines.push('- **2D Sketching** - Lines, circles, arcs, rectangles, and other 2D geometry');
  lines.push('- **3D Operations** - Extrude, revolve, loft, sweep, booleans, and modifications');
  lines.push('- **Transforms** - Translate, rotate, mirror, copy, and repeat');
  lines.push('- **Utilities** - Select, color, remove, load, and other utilities');
  lines.push('');
  lines.push('## Types');
  lines.push('');
  lines.push('Return types from feature functions. These provide methods for further operations on created geometry.');
  lines.push('');
  lines.push('- [**SceneObject**](/docs/api/types/scene-object) - Base type for all scene objects');
  lines.push('- [**Extrude**](/docs/api/types/extrude) - Return type for `extrude()`');
  lines.push('- [**Revolve**](/docs/api/types/revolve) - Return type for `revolve()`');
  lines.push('- [**Loft**](/docs/api/types/loft) - Return type for `loft()`');
  lines.push('- [**Sweep**](/docs/api/types/sweep) - Return type for `sweep()`');
  lines.push('');
  lines.push('## Filters');
  lines.push('');
  lines.push('Filter builders for selecting specific faces and edges.');
  lines.push('');
  lines.push('- [**FaceFilter**](/docs/api/filters/face-filter) - Filter faces by shape, plane, and orientation');
  lines.push('- [**EdgeFilter**](/docs/api/filters/edge-filter) - Filter edges by curve type, plane, and orientation');
  lines.push('');
  lines.push('## Constraints');
  lines.push('');
  lines.push('Constraint qualifiers for tangent geometry.');
  lines.push('');
  lines.push('- [**Constraints**](/docs/api/constraints) - `outside()`, `enclosed()`, `enclosing()`, `unqualified()`');
  lines.push('');

  return lines.join('\n');
}

// ── Custom Type Pages ──

function renderOptionsTypePage(type: TypeEntry, shortDescription: string, bodyDescription: string): string {
  const props = optionsTypeProperties[type.displayName];
  if (!props) {
    return '';
  }

  const rows = props.map(p => {
    const opt = p.optional ? ' *(optional)*' : '';
    const desc = escapeForTable(p.description) + opt;
    const typeDisplay = formatParamType(p.type);
    return `| \`${p.name}\` | ${typeDisplay} | ${desc} |`;
  }).join('\n');

  return `---
sidebar_position: ${type.sidebarPosition}
sidebar_label: "${type.displayName}"
title: "${type.displayName}"
description: "${shortDescription}"
---

# ${type.displayName}

${bodyDescription}

## Properties

| Property | Type | Description |
|----------|------|-------------|
${rows}
`;
}

const customTypePages: Record<string, (type: TypeEntry) => string> = {
  Point2DLike: (type) => `---
sidebar_position: ${type.sidebarPosition}
title: "${type.displayName}"
description: "A 2D point accepted by sketching functions."
---

# ${type.displayName}

A 2D point used by all sketching functions. Any of the following formats are accepted:

| Format | Example | Description |
|--------|---------|-------------|
| \`[number, number]\` | \`[10, 20]\` | Tuple of x, y coordinates |
| \`number[]\` | \`[10, 20]\` | Array of x, y coordinates |
| \`{ x, y }\` | \`{ x: 10, y: 20 }\` | Object with x, y properties |
| [\`Vertex\`](/docs/api/types/vertex) | \`line(...).end()\` | A vertex returned by a geometry method |
`,

  PointLike: (type) => `---
sidebar_position: ${type.sidebarPosition}
title: "${type.displayName}"
description: "A 3D point accepted by translate and other 3D operations."
---

# ${type.displayName}

A 3D point used by operations like \`translate()\`. Any of the following formats are accepted:

| Format | Example | Description |
|--------|---------|-------------|
| \`[number, number, number]\` | \`[10, 20, 30]\` | Tuple of x, y, z coordinates |
| \`{ x, y, z }\` | \`{ x: 10, y: 20, z: 30 }\` | Object with x, y, z properties |
`,

  PlaneLike: (type) => `---
sidebar_position: ${type.sidebarPosition}
title: "${type.displayName}"
description: "A plane reference accepted by 3D operations and sketching functions."
---

# ${type.displayName}

A plane reference used by \`sketch()\`, filters, and other operations. Any of the following formats are accepted:

| Format | Example | Description |
|--------|---------|-------------|
| Standard plane string | \`"xy"\`, \`"xz"\`, \`"yz"\` | The three principal planes |
| Negative plane string | \`"-xy"\`, \`"-xz"\`, \`"-yz"\` | Principal planes with flipped normals |
| Named plane string | \`"top"\`, \`"bottom"\`, \`"front"\`, \`"back"\`, \`"left"\`, \`"right"\` | Descriptive aliases for the principal planes |
| [\`Plane\`](/docs/api/types/plane) | \`plane("xy", 10)\` | A plane object created with \`plane()\` |
| [\`SceneObject\`](/docs/api/types/scene-object) | A face selection | A planar face to use as reference |
`,

  AxisLike: (type) => `---
sidebar_position: ${type.sidebarPosition}
title: "${type.displayName}"
description: "An axis reference accepted by revolve and other axis-based operations."
---

# ${type.displayName}

An axis reference used by \`revolve()\` and other axis-based operations. Any of the following formats are accepted:

| Format | Example | Description |
|--------|---------|-------------|
| Standard axis string | \`"x"\`, \`"y"\`, \`"z"\` | The three principal axes |
| [\`Axis\`](/docs/api/types/axis) | \`axis("x", [0, 10])\` | An axis object created with \`axis()\` |
`,

  LinearRepeatOptions: (type) => renderOptionsTypePage(type,
    'Options for linear repeat.',
    'Options for [`repeat("linear", ...)`](/docs/api/features/transforms/repeat).',
  ),

  CircularRepeatOptions: (type) => renderOptionsTypePage(type,
    'Options for circular repeat.',
    'Options for [`repeat("circular", ...)`](/docs/api/features/transforms/repeat).',
  ),

  Vertex: (type) => `---
sidebar_position: ${type.sidebarPosition}
title: "${type.displayName}"
description: "A lazy-evaluated vertex representing a point on geometry."
---

# ${type.displayName}

A lazy-evaluated vertex representing a point on geometry. Vertices are returned by methods like \`start()\`, \`end()\`, and \`tangent()\` on [\`Geometry\`](/docs/api/types/geometry) types.

Vertices can be passed as a [\`Point2DLike\`](/docs/api/types/point2dlike) to any function that accepts a 2D point, allowing you to reference points on existing geometry.
`,
};

export function getCustomTypePage(type: TypeEntry): string | null {
  const renderer = customTypePages[type.displayName];
  return renderer ? renderer(type) : null;
}
