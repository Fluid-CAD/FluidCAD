import { Project, SyntaxKind, InterfaceDeclaration, ClassDeclaration, SourceFile } from 'ts-morph';
import * as fs from 'fs';
import * as path from 'path';
import {
  features, types, filters, constraints,
  categoryLabels, categoryPositions,
  resolveTypeName, typeSlug,
  getInheritanceChain,
  FeatureCategory,
} from './api-doc-config.ts';
import {
  SignatureInfo, ParamInfo, MethodInfo, ExampleFile, ConstraintInfo,
  InheritedMethodGroup,
  renderFeaturePage, renderTypePage, renderFilterPage,
  renderConstraintsPage, renderIndexPage, getCustomTypePage,
} from './api-doc-templates.ts';

const ROOT = path.resolve(__dirname, '..', '..');
const LIB_DIR = path.join(ROOT, 'lib');
const WEBSITE_DIR = path.join(ROOT, 'website');
const OUTPUT_DIR = path.join(WEBSITE_DIR, 'docs', 'api');
const EXAMPLES_DIR = path.join(OUTPUT_DIR, '_examples');
const STATIC_IMG_DIR = path.join(WEBSITE_DIR, 'static', 'img', 'docs', 'api');

// ── Helpers ──

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeCategoryJson(dir: string, label: string, position: number) {
  const content = JSON.stringify({ label, position }, null, 2) + '\n';
  fs.writeFileSync(path.join(dir, '_category_.json'), content);
}

function findExamples(featureName: string): ExampleFile[] {
  if (!fs.existsSync(EXAMPLES_DIR)) {
    return [];
  }

  const files = fs.readdirSync(EXAMPLES_DIR)
    .filter(f => f.startsWith(featureName + '-') && f.endsWith('.js'))
    .sort();

  return files.map((f) => {
    const baseName = path.basename(f, '.js');
    const importName = baseName.replace(/[^a-zA-Z0-9]/g, '_') + 'Example';

    // Check for corresponding screenshot
    const screenshotFile = path.join(STATIC_IMG_DIR, baseName + '.png');
    const screenshotPath = fs.existsSync(screenshotFile)
      ? `/img/docs/api/${baseName}.png`
      : undefined;

    return {
      importName,
      relativePath: `./_examples/${f}`,
      screenshotPath,
    };
  });
}

function getJsDocDescription(node: any): string {
  const jsDocs = node.getJsDocs?.();
  if (!jsDocs || jsDocs.length === 0) {
    return '';
  }
  return jsDocs[0].getDescription?.()?.trim() || '';
}

function hasInternalTag(node: any): boolean {
  const jsDocs = node.getJsDocs?.();
  if (!jsDocs || jsDocs.length === 0) {
    return false;
  }
  for (const doc of jsDocs) {
    for (const tag of doc.getTags?.() || []) {
      if (tag.getTagName() === 'internal') {
        return true;
      }
    }
  }
  return false;
}

function getJsDocParams(node: any): Map<string, string> {
  const params = new Map<string, string>();
  const jsDocs = node.getJsDocs?.();
  if (!jsDocs || jsDocs.length === 0) {
    return params;
  }

  for (const tag of jsDocs[0].getTags?.() || []) {
    if (tag.getTagName() === 'param') {
      const name = tag.getName?.() || tag.getTagName();
      const comment = tag.getCommentText?.() || tag.getComment?.() || '';
      if (name && name !== 'param') {
        params.set(name, typeof comment === 'string' ? comment.trim() : '');
      }
    }
  }
  return params;
}

// ── Extractors ──

function extractSignaturesFromInterface(
  iface: InterfaceDeclaration,
): SignatureInfo[] {
  const callSigs = iface.getCallSignatures();
  const results: SignatureInfo[] = [];

  for (const sig of callSigs) {
    const description = getJsDocDescription(sig);
    const jsDocParams = getJsDocParams(sig);

    const params: ParamInfo[] = [];
    let isPlaneVariant = false;

    for (const param of sig.getParameters()) {
      const paramName = param.getName();
      const paramType = param.getType().getText(param);
      const isOptional = param.isOptional();
      const isRest = param.isRestParameter();

      // Simplify type text by removing import paths
      const cleanType = simplifyType(paramType);

      // Detect plane variant: last param is PlaneLike or contains PlaneLike
      if (cleanType.includes('PlaneLike') && param === sig.getParameters()[sig.getParameters().length - 1]) {
        isPlaneVariant = true;
      }

      const desc = jsDocParams.get(paramName.replace('...', '')) || '';

      params.push({
        name: isRest ? `...${paramName}` : paramName,
        type: cleanType,
        description: desc,
        optional: isOptional,
      });
    }

    const returnType = simplifyType(sig.getReturnType().getText(sig));

    results.push({
      description,
      params,
      returnType,
      isPlaneVariant,
    });
  }

  return results;
}

function extractMethodsFromInterface(
  iface: InterfaceDeclaration,
): MethodInfo[] {
  const methods: MethodInfo[] = [];

  for (const method of iface.getMethods()) {
    if (hasInternalTag(method)) {
      continue;
    }
    const name = method.getName();
    const description = getJsDocDescription(method);
    const jsDocParams = getJsDocParams(method);

    const params: ParamInfo[] = [];
    for (const param of method.getParameters()) {
      const paramName = param.getName();
      const paramType = simplifyType(param.getType().getText(param));
      const isOptional = param.isOptional();
      const isRest = param.isRestParameter();
      const desc = jsDocParams.get(paramName.replace('...', '')) || '';

      params.push({
        name: isRest ? `...${paramName}` : paramName,
        type: paramType,
        description: desc,
        optional: isOptional,
      });
    }

    const returnType = simplifyType(method.getReturnType().getText(method));

    // Build signature string
    const paramStr = params.map(p => {
      const opt = p.optional ? '?' : '';
      const displayType = resolveTypeName(p.type);
      if (p.name.startsWith('...')) {
        return `${p.name}: ${displayType}`;
      }
      return `${p.name}${opt}: ${displayType}`;
    }).join(', ');

    const retDisplay = resolveTypeName(returnType);
    const sigStr = `${name}(${paramStr}): ${retDisplay}`;

    methods.push({
      name,
      description,
      params,
      returnType,
      signatures: [sigStr],
    });
  }

  return methods;
}

function extractMethodsFromClass(
  cls: ClassDeclaration,
): MethodInfo[] {
  const methods: MethodInfo[] = [];

  for (const method of cls.getMethods()) {
    // Skip private/protected and static methods
    if (method.hasModifier(SyntaxKind.PrivateKeyword) ||
        method.hasModifier(SyntaxKind.ProtectedKeyword)) {
      continue;
    }
    // Skip the static build() method
    if (method.hasModifier(SyntaxKind.StaticKeyword)) {
      continue;
    }
    // Skip methods marked @internal
    if (hasInternalTag(method)) {
      continue;
    }

    const name = method.getName();
    const description = getJsDocDescription(method);
    const jsDocParams = getJsDocParams(method);

    const params: ParamInfo[] = [];
    for (const param of method.getParameters()) {
      const paramName = param.getName();
      const paramType = simplifyType(param.getType().getText(param));
      const isOptional = param.isOptional() || param.hasInitializer();
      const isRest = param.isRestParameter();
      const desc = jsDocParams.get(paramName.replace('...', '')) || '';

      // Skip internal params that users don't interact with (shapes, originalShapes)
      if (paramName === 'shapes' || paramName === 'originalShapes') {
        continue;
      }

      params.push({
        name: isRest ? `...${paramName}` : paramName,
        type: paramType,
        description: desc,
        optional: isOptional,
      });
    }

    const returnType = 'this';

    // Build signature string
    const paramStr = params.map(p => {
      const opt = p.optional ? '?' : '';
      const displayType = resolveTypeName(p.type);
      if (p.name.startsWith('...')) {
        return `${p.name}: ${displayType}[]`;
      }
      return `${p.name}${opt}: ${displayType}`;
    }).join(', ');

    const sigStr = `.${name}(${paramStr}): ${returnType}`;

    methods.push({
      name,
      description,
      params,
      returnType,
      signatures: [sigStr],
    });
  }

  return methods;
}

function extractConstraintInfo(
  sourceFile: SourceFile,
  funcName: string,
): ConstraintInfo | null {
  const func = sourceFile.getFunction(funcName);
  if (!func) {
    return null;
  }

  const description = getJsDocDescription(func);
  const jsDocParams = getJsDocParams(func);

  const params: ParamInfo[] = [];
  for (const param of func.getParameters()) {
    const paramName = param.getName();
    const paramType = simplifyType(param.getType().getText(param));
    const isOptional = param.isOptional();
    const desc = jsDocParams.get(paramName) || '';

    params.push({
      name: paramName,
      type: paramType,
      description: desc,
      optional: isOptional,
    });
  }

  const returnType = simplifyType(func.getReturnType().getText(func));

  return {
    name: funcName,
    description,
    params,
    returnType,
  };
}

function extractPartSignatures(): SignatureInfo[] {
  return [
    {
      description: 'Creates an isolation boundary so shapes inside the part stay separate from the rest of the scene.',
      params: [
        { name: 'name', type: 'string', description: 'The part name.', optional: false },
        { name: 'callback', type: '() => void', description: 'Callback containing the part geometry.', optional: false },
      ],
      returnType: 'ISceneObject',
      isPlaneVariant: false,
    },
  ];
}

// Simplify type text by removing import(...) paths and internal types
function simplifyType(typeText: string): string {
  // Remove import("..."). prefixes
  let simplified = typeText.replace(/import\("[^"]*"\)\./g, '');
  // Remove default. prefix
  simplified = simplified.replace(/default\./g, '');
  // Simplify FilterBuilderBase<Shape<TopoDS_Shape>> to FaceFilter | EdgeFilter
  simplified = simplified.replace(/FilterBuilderBase<Shape<TopoDS_Shape>>/g, 'FaceFilterBuilder | EdgeFilterBuilder');
  // Simplify Shape<TopoDS_Shape> to Shape
  simplified = simplified.replace(/Shape<TopoDS_Shape>/g, 'Shape');
  // Simplify TopoDS_* types
  simplified = simplified.replace(/TopoDS_\w+/g, 'Shape');
  return simplified;
}

// ── Main Generation ──

function generate() {
  console.log('Generating API docs...');

  const project = new Project({
    tsConfigFilePath: path.join(WEBSITE_DIR, 'tsconfig.typedoc.json'),
    skipAddingFilesFromTsConfig: true,
  });

  // Add only the source files we need
  const sourceFiles = new Set<string>();
  for (const f of features) {
    sourceFiles.add(path.join(LIB_DIR, f.sourceFile));
  }
  for (const t of types) {
    sourceFiles.add(path.join(LIB_DIR, t.sourceFile));
  }
  for (const f of filters) {
    sourceFiles.add(path.join(LIB_DIR, f.sourceFile));
  }
  for (const c of constraints) {
    sourceFiles.add(path.join(LIB_DIR, c.sourceFile));
  }
  for (const sf of sourceFiles) {
    project.addSourceFileAtPath(sf);
  }

  // Resolve dependencies
  project.resolveSourceFileDependencies();

  // ── Setup output directories ──

  // Clean existing generated docs (preserve _examples)
  if (fs.existsSync(OUTPUT_DIR)) {
    const entries = fs.readdirSync(OUTPUT_DIR);
    for (const entry of entries) {
      if (entry === '_examples') {
        continue;
      }
      const entryPath = path.join(OUTPUT_DIR, entry);
      fs.rmSync(entryPath, { recursive: true, force: true });
    }
  }

  ensureDir(OUTPUT_DIR);
  ensureDir(EXAMPLES_DIR);

  const featuresDir = path.join(OUTPUT_DIR, 'features');
  ensureDir(featuresDir);
  writeCategoryJson(featuresDir, 'Features', 1);

  // Create category directories
  const categoryDirs: Record<FeatureCategory, string> = {
    '2d': path.join(featuresDir, '2d'),
    '3d': path.join(featuresDir, '3d'),
    'transforms': path.join(featuresDir, 'transforms'),
    'utilities': path.join(featuresDir, 'utilities'),
  };

  for (const [cat, dir] of Object.entries(categoryDirs)) {
    ensureDir(dir);
    writeCategoryJson(dir, categoryLabels[cat as FeatureCategory], categoryPositions[cat as FeatureCategory]);
  }

  const typesDir = path.join(OUTPUT_DIR, 'types');
  ensureDir(typesDir);
  writeCategoryJson(typesDir, 'Types', 2);

  const filtersDir = path.join(OUTPUT_DIR, 'filters');
  ensureDir(filtersDir);
  writeCategoryJson(filtersDir, 'Filters', 3);

  // ── Generate Feature Pages ──

  console.log('Generating feature pages...');
  let featureCount = 0;

  for (const feature of features) {
    const sourceFilePath = path.join(LIB_DIR, feature.sourceFile);
    const sf = project.getSourceFile(sourceFilePath);
    if (!sf) {
      console.warn(`  Warning: Source file not found: ${feature.sourceFile}`);
      continue;
    }

    let sigs: SignatureInfo[] = [];

    if (feature.interfaceName) {
      const iface = sf.getInterface(feature.interfaceName);
      if (iface) {
        sigs = extractSignaturesFromInterface(iface);
      } else {
        console.warn(`  Warning: Interface ${feature.interfaceName} not found in ${feature.sourceFile}`);
      }
    } else if (feature.name === 'part') {
      sigs = extractPartSignatures();
    }

    const examples = findExamples(feature.name);
    const categories = Array.isArray(feature.category) ? feature.category : [feature.category];
    for (const cat of categories) {
      const posOverride = feature.sidebarPositions?.[cat];
      const mdx = renderFeaturePage(feature, sigs, examples, posOverride);
      const outputFile = path.join(categoryDirs[cat], `${feature.name}.mdx`);
      fs.writeFileSync(outputFile, mdx);
    }
    featureCount++;
  }

  console.log(`  Generated ${featureCount} feature pages.`);

  // ── Generate Type Pages ──

  console.log('Generating type pages...');
  let typeCount = 0;

  for (const type of types) {
    // Handle special type-alias / class types with custom pages
    const customPage = getCustomTypePage(type);
    if (customPage) {
      const slug = typeSlug(type.displayName);
      const outputFile = path.join(typesDir, `${slug}.mdx`);
      fs.writeFileSync(outputFile, customPage);
      typeCount++;
      continue;
    }

    const sourceFilePath = path.join(LIB_DIR, type.sourceFile);
    const sf = project.getSourceFile(sourceFilePath);
    if (!sf) {
      console.warn(`  Warning: Source file not found: ${type.sourceFile}`);
      continue;
    }

    const iface = sf.getInterface(type.name);
    if (!iface) {
      console.warn(`  Warning: Interface ${type.name} not found in ${type.sourceFile}`);
      continue;
    }

    const methods = extractMethodsFromInterface(iface);

    // Resolve inherited methods from parent types
    const inheritedGroups: InheritedMethodGroup[] = [];
    const chain = getInheritanceChain(type.name);
    for (const parentType of chain) {
      const parentSourcePath = path.join(LIB_DIR, parentType.sourceFile);
      const parentSf = project.getSourceFile(parentSourcePath);
      if (!parentSf) {
        continue;
      }
      const parentIface = parentSf.getInterface(parentType.name);
      if (!parentIface) {
        continue;
      }
      const parentMethods = extractMethodsFromInterface(parentIface);
      if (parentMethods.length > 0) {
        inheritedGroups.push({ parentType, methods: parentMethods });
      }
    }

    const mdx = renderTypePage(type, methods, inheritedGroups);
    const slug = typeSlug(type.displayName);
    const outputFile = path.join(typesDir, `${slug}.mdx`);
    fs.writeFileSync(outputFile, mdx);
    typeCount++;
  }

  console.log(`  Generated ${typeCount} type pages.`);

  // ── Generate Filter Pages ──

  console.log('Generating filter pages...');

  for (const filter of filters) {
    const sourceFilePath = path.join(LIB_DIR, filter.sourceFile);
    const sf = project.getSourceFile(sourceFilePath);
    if (!sf) {
      console.warn(`  Warning: Source file not found: ${filter.sourceFile}`);
      continue;
    }

    const cls = sf.getClass(filter.className);
    if (!cls) {
      console.warn(`  Warning: Class ${filter.className} not found in ${filter.sourceFile}`);
      continue;
    }

    const methods = extractMethodsFromClass(cls);
    const mdx = renderFilterPage(filter, methods);
    const outputFile = path.join(filtersDir, `${filter.name}-filter.mdx`);
    fs.writeFileSync(outputFile, mdx);
  }

  console.log(`  Generated ${filters.length} filter pages.`);

  // ── Generate Constraints Page ──

  console.log('Generating constraints page...');

  const constraintInfos: ConstraintInfo[] = [];
  const constraintSourcePath = path.join(LIB_DIR, constraints[0].sourceFile);
  const constraintSf = project.getSourceFile(constraintSourcePath);

  if (constraintSf) {
    for (const c of constraints) {
      const info = extractConstraintInfo(constraintSf, c.functionName);
      if (info) {
        constraintInfos.push(info);
      }
    }
  }

  const constraintsMdx = renderConstraintsPage(constraintInfos);
  fs.writeFileSync(path.join(OUTPUT_DIR, 'constraints.mdx'), constraintsMdx);

  console.log(`  Generated constraints page with ${constraintInfos.length} functions.`);

  // ── Generate Index Page ──

  const indexMdx = renderIndexPage();
  fs.writeFileSync(path.join(OUTPUT_DIR, 'index.mdx'), indexMdx);
  console.log('  Generated index page.');

  console.log(`\nDone! Generated API docs in ${path.relative(ROOT, OUTPUT_DIR)}`);
}

generate();
