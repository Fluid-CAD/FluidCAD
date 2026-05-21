// Generates `llm-docs/api/types/*.md` — one file per entry in the website's
// `types[]` config. Three rendering modes:
//
//   1. Interface types (ISceneObject, IExtrude, ...) — methods + inherited
//      methods extracted via ts-morph from `lib/`.
//   2. Union / string-literal aliases (PlaneLike, AxisLike, PointLike,
//      Point2DLike, Vertex) — hand-curated content from
//      `scripts/llm-type-content.ts`.
//   3. Options bags (LinearRepeatOptions, ...) — rendered from
//      `optionsTypeProperties` in `website/scripts/api-doc-config.ts`.
//
// The output files are picked up by `scripts/build-llm-docs.ts` like any other
// llm-docs markdown — no changes to the index builder needed.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  InterfaceDeclaration,
  MethodSignature,
  Project,
} from 'ts-morph';

// `website/` is a CommonJS workspace, so static ESM imports don't see its
// named exports through tsx's CJS shim. Use a dynamic import in main() and
// pull the named exports off `.default` when present (same pattern as
// `check-llm-docs-coverage.ts`). The `type` imports below are erased at build
// time so they don't trigger a runtime resolution.
import type {
  TypeEntry,
  OptionsProperty,
} from '../website/scripts/api-doc-config.ts';
import {
  unionAliases,
  optionsBags,
  type AcceptedForm,
} from './llm-type-content.ts';

type ApiDocConfigModule = {
  types: TypeEntry[];
  typeDisplayNameMap: Record<string, string>;
  optionsTypeProperties: Record<string, OptionsProperty[]>;
  typeSlug(name: string): string;
  resolveTypeName(raw: string): string;
  getInheritanceChain(typeName: string): TypeEntry[];
};

let configModule: ApiDocConfigModule | undefined;

async function loadConfig(): Promise<ApiDocConfigModule> {
  if (configModule) {
    return configModule;
  }
  const mod = await import('../website/scripts/api-doc-config.ts');
  const ns = (mod as any).default ?? mod;
  configModule = {
    types: ns.types,
    typeDisplayNameMap: ns.typeDisplayNameMap,
    optionsTypeProperties: ns.optionsTypeProperties,
    typeSlug: ns.typeSlug,
    resolveTypeName: ns.resolveTypeName,
    getInheritanceChain: ns.getInheritanceChain,
  };
  return configModule;
}

function cfg(): ApiDocConfigModule {
  if (!configModule) {
    throw new Error('Config not loaded — call loadConfig() first.');
  }
  return configModule;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LIB_DIR = path.join(REPO_ROOT, 'lib');
const WEBSITE_DIR = path.join(REPO_ROOT, 'website');
const OUT_DIR = path.join(REPO_ROOT, 'llm-docs', 'api', 'types');

// ── seeAlso mappings ──
//
// Hand-curated because computing referencing features from source would be
// noisy. Keep this terse — 3–5 entries per type, leaning toward the most
// likely next read.

const seeAlsoByDisplay: Record<string, string[]> = {
  // Union / literal aliases
  PlaneLike: ['api/sketch', 'api/plane', 'api/types/plane', 'api/types/scene-object'],
  AxisLike: ['api/revolve', 'api/axis', 'api/types/axis'],
  PointLike: ['api/translate'],
  Point2DLike: ['api/line', 'api/rect', 'api/types/vertex'],
  Vertex: ['api/types/point2dlike'],

  // Options
  LinearRepeatOptions: ['api/repeat'],
  CircularRepeatOptions: ['api/repeat'],
  PlaneTransformOptions: ['api/plane'],

  // Interfaces — return types of features
  SceneObject: ['api/select', 'concepts/scene-graph'],
  Transformable: ['api/types/scene-object', 'api/translate', 'api/rotate'],
  BooleanOperation: ['api/types/scene-object', 'concepts/scene-graph'],
  Geometry: ['api/types/scene-object'],
  ExtrudableGeometry: ['api/types/geometry', 'api/extrude'],
  Extrude: ['api/extrude', 'api/types/boolean-operation'],
  Cut: ['api/cut'],
  Revolve: ['api/revolve', 'api/types/boolean-operation'],
  Loft: ['api/loft', 'api/types/boolean-operation'],
  Sweep: ['api/sweep', 'api/types/boolean-operation'],
  Mirror: ['api/mirror', 'api/types/boolean-operation'],
  Common: ['api/booleans'],
  Shell: ['api/shell'],
  Draft: ['api/draft'],
  Rib: ['api/rib'],
  ArcPoints: ['api/arc'],
  ArcAngles: ['api/arc'],
  Rect: ['api/rect'],
  Slot: ['api/slot'],
  ALine: ['api/line'],
  HLine: ['api/line'],
  VLine: ['api/line'],
  Polygon: ['api/polygon'],
  Offset: ['api/offset'],
  Plane: ['api/plane', 'api/types/plane-like'],
  Axis: ['api/axis', 'api/types/axis-like'],
  Select: ['api/select'],
  TwoObjectsTangentLine: ['api/tline'],
  TangentArcTwoObjects: ['api/tarc'],
  Trim: ['api/split-trim'],
};

// ── Helpers ──

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function aliasesFor(displayName: string, primaryInternal: string): string[] {
  // Collect every internal alias from typeDisplayNameMap that points at this
  // display name. The primary internal name (TypeEntry.name) is included by
  // the caller separately; we exclude it here to avoid duplicates.
  const out: string[] = [];
  for (const [internal, display] of Object.entries(cfg().typeDisplayNameMap)) {
    if (display === displayName && internal !== displayName && internal !== primaryInternal) {
      out.push(internal);
    }
  }
  return out;
}

function escapePipes(text: string): string {
  return text.replace(/\|/g, '\\|');
}

function cleanDescription(text: string): string {
  // Strip leading "- " from @param descriptions and resolve {@link Foo}.
  return text.replace(/^-\s+/, '').replace(/\{@link\s+([^}]+)\}/g, '$1');
}

function tableRow(cells: string[]): string {
  return '| ' + cells.map((c) => escapePipes(c.replace(/\n/g, ' '))).join(' | ') + ' |';
}

function simplifyType(typeText: string): string {
  let s = typeText.replace(/import\("[^"]*"\)\./g, '');
  s = s.replace(/default\./g, '');
  s = s.replace(/FilterBuilderBase<Shape<TopoDS_Shape>>/g, 'FaceFilterBuilder | EdgeFilterBuilder');
  s = s.replace(/Shape<TopoDS_Shape>/g, 'Shape');
  s = s.replace(/TopoDS_\w+/g, 'Shape');
  return s;
}


function getJsDocDescription(node: { getJsDocs(): { getDescription(): string }[] } | undefined): string {
  if (!node) {
    return '';
  }
  const docs = node.getJsDocs?.();
  if (!docs || docs.length === 0) {
    return '';
  }
  const first = docs[0].getDescription?.() ?? '';
  return first.trim();
}

function getJsDocParams(method: MethodSignature): Map<string, string> {
  const out = new Map<string, string>();
  const docs = method.getJsDocs();
  if (docs.length === 0) {
    return out;
  }
  for (const tag of docs[0].getTags()) {
    if (tag.getTagName() !== 'param') {
      continue;
    }
    const name = (tag as unknown as { getName?(): string }).getName?.() ?? '';
    const commentRaw =
      (tag as unknown as { getCommentText?(): string | undefined }).getCommentText?.() ??
      tag.getComment?.() ??
      '';
    const comment = typeof commentRaw === 'string' ? commentRaw : '';
    if (name) {
      out.set(name, cleanDescription(comment.trim()));
    }
  }
  return out;
}

function hasInternalTag(node: { getJsDocs(): { getTags(): { getTagName(): string }[] }[] }): boolean {
  for (const doc of node.getJsDocs()) {
    for (const tag of doc.getTags()) {
      if (tag.getTagName() === 'internal') {
        return true;
      }
    }
  }
  return false;
}

// ── ts-morph extraction ──

type ExtractedMethod = {
  name: string;
  /** All overload signatures (`foo(): this`, `foo(x: number): this`, ...). */
  signatures: string[];
  description: string;
  params: Array<{ name: string; type: string; description: string; optional: boolean }>;
  returnType: string;
};

function extractMethodsFromInterface(iface: InterfaceDeclaration): ExtractedMethod[] {
  const byName = new Map<string, ExtractedMethod>();
  for (const method of iface.getMethods()) {
    if (hasInternalTag(method)) {
      continue;
    }
    const name = method.getName();
    const description = getJsDocDescription(method);
    const jsDocParams = getJsDocParams(method);

    const params: ExtractedMethod['params'] = [];
    for (const param of method.getParameters()) {
      const paramName = param.getName();
      const rawType = simplifyType(param.getType().getText(param));
      const optional = param.isOptional();
      const rest = param.isRestParameter();
      params.push({
        name: rest ? `...${paramName}` : paramName,
        type: rawType,
        description: jsDocParams.get(paramName.replace(/^\.\.\./, '')) ?? '',
        optional,
      });
    }

    const returnType = simplifyType(method.getReturnType().getText(method));
    const sigStr = renderMethodSignature(name, params, returnType);

    const existing = byName.get(name);
    if (existing) {
      existing.signatures.push(sigStr);
      // Prefer the most descriptive description; keep params from the richest overload.
      if (!existing.description && description) {
        existing.description = description;
      }
      if (params.length > existing.params.length) {
        existing.params = params;
      }
    } else {
      byName.set(name, {
        name,
        signatures: [sigStr],
        description,
        params,
        returnType,
      });
    }
  }
  return [...byName.values()];
}

function renderMethodSignature(
  name: string,
  params: ExtractedMethod['params'],
  returnType: string,
): string {
  const parts = params.map((p) => {
    const opt = p.optional ? '?' : '';
    const type = renderTypeText(p.type);
    if (p.name.startsWith('...')) {
      return `${p.name}: ${type}`;
    }
    return `${p.name}${opt}: ${type}`;
  });
  return `${name}(${parts.join(', ')}): ${renderTypeText(returnType)}`;
}

// Top-level union split that respects nesting in parens/brackets/generics —
// avoids the website's resolveTypeName bug where `(A | B)[]` gets split into
// `(A` and `B)[]`.
function splitTopLevelUnion(raw: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '(' || ch === '[' || ch === '<' || ch === '{') {
      depth++;
    } else if (ch === ')' || ch === ']' || ch === '>' || ch === '}') {
      depth--;
    } else if (
      ch === '|' &&
      depth === 0 &&
      raw[i - 1] === ' ' &&
      raw[i + 1] === ' '
    ) {
      parts.push(raw.slice(start, i - 1));
      start = i + 2;
    }
  }
  parts.push(raw.slice(start));
  return parts.length > 1 ? parts.map((p) => p.trim()) : null;
}

// Display-only rewrite of a type string for use INSIDE code fences. No
// backticks, no links — just internal-to-display swaps recursively.
function renderTypeText(raw: string): string {
  const union = splitTopLevelUnion(raw);
  if (union) {
    return union.map(renderTypeText).join(' | ');
  }
  const parenArray = raw.match(/^\((.+)\)\[\]$/);
  if (parenArray) {
    return `(${renderTypeText(parenArray[1])})[]`;
  }
  const simpleArray = raw.match(/^(.+)\[\]$/);
  if (simpleArray) {
    return `${renderTypeText(simpleArray[1])}[]`;
  }
  return cfg().resolveTypeName(raw.trim());
}

// ── Frontmatter + body assembly ──

type Frontmatter = {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  symbols: string[];
  seeAlso?: string[];
};

function renderFrontmatter(fm: Frontmatter): string {
  const lines: string[] = ['---'];
  lines.push(`id: ${fm.id}`);
  lines.push(`title: ${fm.title}`);
  lines.push(`summary: ${quoteForYaml(fm.summary)}`);
  lines.push(`tags: [${fm.tags.join(', ')}]`);
  lines.push(`symbols: [${fm.symbols.join(', ')}]`);
  if (fm.seeAlso && fm.seeAlso.length > 0) {
    lines.push(`seeAlso: [${fm.seeAlso.join(', ')}]`);
  }
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

function quoteForYaml(text: string): string {
  // js-yaml will parse this back. Use double quotes and escape any embedded
  // double quotes / backslashes. Keep summaries single-line.
  const single = text.replace(/\s+/g, ' ').trim();
  const escaped = single.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

// ── Mode 1: interface types ──

function renderInterfacePage(
  type: TypeEntry,
  iface: InterfaceDeclaration,
  ownMethods: ExtractedMethod[],
  inherited: Array<{ parent: TypeEntry; methods: ExtractedMethod[] }>,
): string {
  const c = cfg();
  const parent = type.extendsType ? c.resolveTypeName(type.extendsType) : undefined;
  const summary = computeInterfaceSummary(type, iface, ownMethods);
  const symbols = uniq([
    type.displayName,
    type.name,
    ...aliasesFor(type.displayName, type.name),
  ]);
  const fmSeeAlso = uniq([
    ...(seeAlsoByDisplay[type.displayName] ?? []),
    ...(parent ? [`api/types/${c.typeSlug(parent)}`] : []),
  ]).filter((s) => s !== `api/types/${c.typeSlug(type.displayName)}`);

  const fm = renderFrontmatter({
    id: `api/types/${c.typeSlug(type.displayName)}`,
    title: type.displayName,
    summary,
    tags: ['api', 'type', 'interface'],
    symbols,
    seeAlso: fmSeeAlso,
  });

  const body: string[] = [];
  body.push(`# ${type.displayName}`);
  body.push('');

  // Full interface definition as the first code block so `firstCodeBlock`
  // returns a usable schema.
  body.push('```ts');
  const header = parent
    ? `interface ${type.displayName} extends ${parent} {`
    : `interface ${type.displayName} {`;
  body.push(header);
  for (const m of ownMethods) {
    for (const sig of m.signatures) {
      body.push(`  ${sig};`);
    }
  }
  if (ownMethods.length === 0) {
    body.push('  // No own methods — see Inherited below.');
  }
  body.push('}');
  body.push('```');
  body.push('');

  const intro = getJsDocDescription(iface);
  if (intro) {
    body.push(intro);
    body.push('');
  }

  if (parent) {
    body.push(`Extends [[api/types/${cfg().typeSlug(parent)}]].`);
    body.push('');
  }

  if (ownMethods.length > 0) {
    body.push('## Methods');
    body.push('');
    for (const m of ownMethods) {
      body.push(...renderMethodBlock(m));
    }
  }

  const inheritedNonEmpty = inherited.filter((g) => g.methods.length > 0);
  if (inheritedNonEmpty.length > 0) {
    body.push('## Inherited');
    body.push('');
    for (const group of inheritedNonEmpty) {
      const slug = cfg().typeSlug(group.parent.displayName);
      body.push(
        `From [[api/types/${slug}]]: ` +
          group.methods.map((m) => `\`${m.name}()\``).join(', '),
      );
      body.push('');
    }
  }

  return fm + body.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function renderMethodBlock(m: ExtractedMethod): string[] {
  const lines: string[] = [];
  lines.push(`### \`${m.name}()\``);
  lines.push('');
  if (m.signatures.length > 1) {
    lines.push('```ts');
    for (const sig of m.signatures) {
      lines.push(sig);
    }
    lines.push('```');
    lines.push('');
  }
  if (m.description) {
    lines.push(cleanDescription(m.description));
    lines.push('');
  }
  if (m.returnType && m.returnType !== 'this' && m.returnType !== 'void') {
    lines.push(`**Returns**: ${linkType(m.returnType)}.`);
    lines.push('');
  }
  if (m.params.length > 0) {
    lines.push(tableRow(['Parameter', 'Type', 'Description']));
    lines.push(tableRow(['---', '---', '---']));
    for (const p of m.params) {
      const opt = p.optional ? ' *(optional)*' : '';
      lines.push(
        tableRow([
          `\`${p.name}\``,
          linkType(p.type),
          cleanDescription(p.description) + opt,
        ]),
      );
    }
    lines.push('');
  }
  return lines;
}

function linkType(raw: string): string {
  // Render a parameter/return type for a markdown TABLE CELL. Linked types
  // use `[[api/types/<slug>]]`; everything else is wrapped in a code span.
  // Pipes are left literal — the table cell renderer escapes them once.
  const union = splitTopLevelUnion(raw);
  if (union) {
    return union.map(linkType).join(' | ');
  }
  const parenArray = raw.match(/^\((.+)\)\[\]$/);
  if (parenArray) {
    return `(${linkType(parenArray[1])})[]`;
  }
  const simpleArray = raw.match(/^(.+)\[\]$/);
  if (simpleArray) {
    return `${linkType(simpleArray[1])}[]`;
  }
  const c = cfg();
  const display = c.resolveTypeName(raw.trim());
  if (c.types.some((t) => t.displayName === display)) {
    return `[[api/types/${c.typeSlug(display)}]]`;
  }
  return `\`${display}\``;
}

function computeInterfaceSummary(
  type: TypeEntry,
  iface: InterfaceDeclaration,
  methods: ExtractedMethod[],
): string {
  const jsdoc = getJsDocDescription(iface);
  if (jsdoc) {
    return firstSentence(jsdoc);
  }
  const parent = type.extendsType ? cfg().resolveTypeName(type.extendsType) : undefined;
  const methodCount = methods.length;
  if (parent && methodCount > 0) {
    return `The ${type.displayName} type. Extends ${parent}; adds ${methodCount} method${methodCount === 1 ? '' : 's'}.`;
  }
  if (parent) {
    return `The ${type.displayName} type. Extends ${parent}.`;
  }
  if (methodCount > 0) {
    return `The ${type.displayName} type. Defines ${methodCount} method${methodCount === 1 ? '' : 's'}.`;
  }
  return `The ${type.displayName} type.`;
}

function firstSentence(text: string): string {
  const idx = text.search(/[.!?](\s|$)/);
  if (idx === -1) {
    return text.replace(/\s+/g, ' ').trim();
  }
  return text.slice(0, idx + 1).replace(/\s+/g, ' ').trim();
}

// ── Mode 2: union / literal aliases ──

function renderUnionAliasPage(type: TypeEntry, definition: string): string {
  const content = unionAliases[type.displayName];
  if (!content) {
    throw new Error(`Missing unionAliases content for ${type.displayName}`);
  }
  const symbols = uniq([
    type.displayName,
    type.name,
    ...aliasesFor(type.displayName, type.name),
  ]);

  const fm = renderFrontmatter({
    id: `api/types/${cfg().typeSlug(type.displayName)}`,
    title: type.displayName,
    summary: content.summary,
    tags: ['api', 'type', 'union'],
    symbols,
    seeAlso: seeAlsoByDisplay[type.displayName],
  });

  const body: string[] = [];
  body.push(`# ${type.displayName}`);
  body.push('');
  body.push('```ts');
  body.push(`type ${type.displayName} = ${definition};`);
  body.push('```');
  body.push('');
  body.push(content.intro);
  body.push('');

  if (content.acceptedForms.length > 0) {
    body.push(tableRow(['Format', 'Example', 'Description']));
    body.push(tableRow(['---', '---', '---']));
    for (const f of content.acceptedForms) {
      body.push(tableRow([renderFormatCell(f), f.example, f.description]));
    }
    body.push('');
  }

  if (content.example) {
    body.push('## Example');
    body.push('');
    body.push('```fluid.js');
    body.push(content.example.trimEnd());
    body.push('```');
    body.push('');
  }

  if (content.trailingNotes) {
    body.push(content.trailingNotes);
    body.push('');
  }

  return fm + body.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function renderFormatCell(f: AcceptedForm): string {
  if (f.link) {
    return `[[${f.link}]]`;
  }
  return f.format;
}

// ── Mode 3: options bags ──

function renderOptionsPage(type: TypeEntry, props: OptionsProperty[]): string {
  const content = optionsBags[type.displayName];
  if (!content) {
    throw new Error(`Missing optionsBags content for ${type.displayName}`);
  }
  const symbols = uniq([
    type.displayName,
    type.name,
    ...aliasesFor(type.displayName, type.name),
  ]);

  const fm = renderFrontmatter({
    id: `api/types/${cfg().typeSlug(type.displayName)}`,
    title: type.displayName,
    summary: content.summary,
    tags: ['api', 'type', 'options'],
    symbols,
    seeAlso: seeAlsoByDisplay[type.displayName],
  });

  const body: string[] = [];
  body.push(`# ${type.displayName}`);
  body.push('');
  body.push('```ts');
  body.push(`type ${type.displayName} = {`);
  for (const p of props) {
    const opt = p.optional ? '?' : '';
    body.push(`  ${p.name}${opt}: ${p.type};`);
  }
  body.push('};');
  body.push('```');
  body.push('');
  body.push(content.description);
  body.push('');
  body.push('## Properties');
  body.push('');
  body.push(tableRow(['Property', 'Type', 'Description']));
  body.push(tableRow(['---', '---', '---']));
  for (const p of props) {
    const opt = p.optional ? ' *(optional)*' : '';
    body.push(
      tableRow([
        `\`${p.name}\``,
        linkType(p.type),
        cleanDescription(p.description) + opt,
      ]),
    );
  }
  body.push('');

  return fm + body.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// ── Categorization ──

function categoryOf(type: TypeEntry): 'union' | 'options' | 'interface' {
  if (unionAliases[type.displayName]) {
    return 'union';
  }
  if (optionsBags[type.displayName]) {
    return 'options';
  }
  return 'interface';
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

// ── Main ──

async function main(): Promise<void> {
  const c = await loadConfig();

  const project = new Project({
    tsConfigFilePath: path.join(WEBSITE_DIR, 'tsconfig.typedoc.json'),
    skipAddingFilesFromTsConfig: true,
  });

  const sourceFiles = new Set<string>();
  for (const t of c.types) {
    sourceFiles.add(path.join(LIB_DIR, t.sourceFile));
  }
  for (const sf of sourceFiles) {
    project.addSourceFileAtPath(sf);
  }
  project.resolveSourceFileDependencies();

  ensureDir(OUT_DIR);

  // Wipe any previously generated type docs so a renamed/removed type doesn't
  // leave a stale file behind.
  for (const entry of fs.readdirSync(OUT_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      fs.unlinkSync(path.join(OUT_DIR, entry.name));
    }
  }

  let written = 0;
  for (const type of c.types) {
    const slug = c.typeSlug(type.displayName);
    const outFile = path.join(OUT_DIR, `${slug}.md`);

    const kind = categoryOf(type);
    let body: string;

    if (kind === 'union') {
      const definition = readTypeAliasText(project, type) ?? type.displayName;
      body = renderUnionAliasPage(type, definition);
    } else if (kind === 'options') {
      const props = c.optionsTypeProperties[type.displayName];
      if (!props) {
        throw new Error(`No optionsTypeProperties entry for ${type.displayName}`);
      }
      body = renderOptionsPage(type, props);
    } else {
      const iface = lookupInterface(project, type);
      if (!iface) {
        console.warn(`  Skipping ${type.displayName}: interface ${type.name} not found in ${type.sourceFile}.`);
        continue;
      }
      const ownMethods = extractMethodsFromInterface(iface);
      const inherited: Array<{ parent: TypeEntry; methods: ExtractedMethod[] }> = [];
      for (const parent of c.getInheritanceChain(type.name)) {
        const parentIface = lookupInterface(project, parent);
        if (!parentIface) {
          continue;
        }
        inherited.push({ parent, methods: extractMethodsFromInterface(parentIface) });
      }
      body = renderInterfacePage(type, iface, ownMethods, inherited);
    }

    fs.writeFileSync(outFile, body);
    written++;
  }

  console.log(`Wrote ${written} type doc(s) under llm-docs/api/types/.`);
}

function lookupInterface(project: Project, type: TypeEntry): InterfaceDeclaration | undefined {
  const sf = project.getSourceFile(path.join(LIB_DIR, type.sourceFile));
  return sf?.getInterface(type.name);
}

function readTypeAliasText(project: Project, type: TypeEntry): string | undefined {
  const sf = project.getSourceFile(path.join(LIB_DIR, type.sourceFile));
  const alias = sf?.getTypeAlias(type.name);
  if (!alias) {
    return undefined;
  }
  return simplifyType(alias.getTypeNode()?.getText() ?? '');
}

main().catch((err) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(msg);
  process.exit(1);
});
