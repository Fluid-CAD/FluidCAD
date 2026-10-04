import path from "path";
import fs from "fs";
import ts from "typescript";

const REPO = path.resolve(import.meta.dirname, "../../..");

/** Where the in-memory files live: a directory that exists only for the compiler host. */
const VIRTUAL_DIR = path.join(REPO, "lib/tests/.check-js");

/** One error the type checker reports in a checked file. */
export type CheckJsDiagnostic = { file: string; line: number; message: string };

/**
 * Plain JavaScript type-checked the way a project's editor checks it: the
 * `checkJs` jsconfig `fluidcad init` writes, under the strict defaults of
 * TypeScript 6 (`npx tsc -p jsconfig.json` in a project). `fluidcad/*`
 * imports resolve to the engine's sources, so a check always describes the
 * code under test, never a stale build.
 */
export class CheckJs {

  /** The package subpaths a feature module or a model imports, mapped to their sources. */
  private static readonly ENTRY_POINTS: Record<string, string> = {
    "fluidcad": "lib/index.ts",
    "fluidcad/sdk": "lib/sdk/index.ts",
    "fluidcad/sdk/kernel": "lib/sdk/kernel.ts",
    "fluidcad/core": "lib/core/index.ts",
    "fluidcad/filters": "lib/filters/index.ts",
    "fluidcad/constraints": "lib/core/constraints/index.ts",
    "fluidcad/math": "lib/math/index.ts",
  };

  private static readonly OPTIONS: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    baseUrl: REPO,
    paths: Object.fromEntries(Object.entries(CheckJs.ENTRY_POINTS).map(([specifier, source]) => [specifier, [source]])),
  };

  private constructor(
    private readonly program: ts.Program,
    private readonly roots: string[],
  ) {}

  /**
   * Check `files`: in-memory sources by name (`'standoff.feature.js'`), which
   * import each other relatively, and paths of files on disk.
   */
  static check(files: Record<string, string>, onDisk: string[] = []): CheckJs {
    const virtual = new Map(Object.entries(files).map(([name, source]) => [path.join(VIRTUAL_DIR, name), source]));
    const host = ts.createCompilerHost(CheckJs.OPTIONS, true);
    const { fileExists, readFile, directoryExists, getSourceFile } = host;
    host.fileExists = file => virtual.has(file) || fileExists.call(host, file);
    host.readFile = file => virtual.get(file) ?? readFile.call(host, file);
    host.directoryExists = dir => dir === VIRTUAL_DIR || (directoryExists ? directoryExists.call(host, dir) : fs.existsSync(dir));
    host.getSourceFile = (file, language, onError, create) => {
      const source = virtual.get(file);
      return source === undefined
        ? getSourceFile.call(host, file, language, onError, create)
        : ts.createSourceFile(file, source, language, true);
    };
    const roots = [...virtual.keys(), ...onDisk.map(file => path.resolve(file))];
    return new CheckJs(ts.createProgram(roots, CheckJs.OPTIONS, host), roots);
  }

  /** The errors in the checked files (none from the engine's own sources). */
  diagnostics(): CheckJsDiagnostic[] {
    return this.roots.flatMap(root => {
      const sourceFile = this.program.getSourceFile(root)!;
      return [...this.program.getSyntacticDiagnostics(sourceFile), ...this.program.getSemanticDiagnostics(sourceFile)].map(diagnostic => ({
        file: path.basename(root),
        line: diagnostic.start === undefined ? 0 : sourceFile.getLineAndCharacterOfPosition(diagnostic.start).line + 1,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      }));
    });
  }

  /** The type of the variable `name` declared in `file` (its first declaration), as the editor prints it. */
  typeOf(file: string, name: string): string {
    const root = this.roots.find(candidate => path.basename(candidate) === file);
    if (!root) {
      throw new Error(`${file} is not one of the checked files`);
    }
    const checker = this.program.getTypeChecker();
    let found: ts.Identifier | null = null;
    const visit = (node: ts.Node): void => {
      if (found) {
        return;
      }
      if ((ts.isVariableDeclaration(node) || ts.isBindingElement(node)) && ts.isIdentifier(node.name) && node.name.text === name) {
        found = node.name;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(this.program.getSourceFile(root)!);
    if (!found) {
      throw new Error(`${file} declares no variable '${name}'`);
    }
    return checker.typeToString(checker.getTypeAtLocation(found), undefined, ts.TypeFormatFlags.NoTruncation);
  }
}
