import type { ErrorRequestHandler, Response } from 'express';
import { PackageRoots, type PackageLocation } from './package-roots.ts';
import { GeneratedReadOnlyError, GeneratedRows, type RowLocation, type RowTarget } from '../generated-rows.ts';

/** A write aimed at an installed package's file, refused (K8). */
export class PackageReadOnlyError extends Error {
  constructor(readonly location: PackageLocation, readonly file: string) {
    super(PackageRoots.readOnlySentence(location, file));
    this.name = 'PackageReadOnlyError';
  }
}

/** A message the server hands an editor host. */
type HostMessage = Record<string, any>;
type HostSend = (msg: any) => boolean;

/**
 * Installed packages are immutable (K8): the server refuses every edit
 * whose target file is under a package root, with one sentence —
 * "`parts/spur.part.js` belongs to `@acme/gears` 1.2.0 and is read-only."
 * The root test is `PackageRoots.owner` (location plus marker), so a fork
 * of a package copied elsewhere in the workspace stays editable.
 *
 * Three layers ask it, so no edit path needs to remember it:
 * - **the edit dispatch** (`FeatureEditDispatcher`): every
 *   `apply-feature-edit` spec, the cross-file creates included (an
 *   `expose()` or a connector written into a donor part file);
 * - **the host send** ({@link guardSend}): every other message a route hands
 *   an editor host — a breakpoint, a sketch edit, a rename — refused by the
 *   file it names, else by the open file it edits;
 * - **routes with side effects before the edit** (set-part-material copies
 *   a material into `fluidcad.json` first), which ask {@link refuse} up
 *   front.
 * The file routes refuse writes into a project copy themselves.
 *
 * **Engine-owned rows (G8).** The same three layers refuse a write aimed at
 * a row the engine made for a generated definition — a generator's parts
 * and records, a `definePart` part — whose statement is no one's to edit
 * ({@link GeneratedRows}, from the last render): by the statement the write
 * addresses (a spec's row edit, a host message's location), and by the row
 * a route was told it comes from (`row`, {@link refuseRow}). The answer is
 * 403 with `code: 'generated-read-only'`.
 */
export class PackageEditGuard {
  /**
   * The host messages that edit source (ws-protocol's server→editor
   * contract). Everything else a route hands a host — a replayed
   * `scene-rendered`, a `goto-source`, `clear-breakpoints`, which touches
   * whatever the editor holds — edits no one file and passes. A new edit
   * rides `apply-feature-edit` (the plan rules forbid new host messages).
   */
  static readonly EDITS: ReadonlySet<string> = new Set([
    'apply-feature-edit',
    'add-breakpoint',
    'remove-feature',
    'rename-feature',
    'set-unit',
    'update-insert-chain',
    'insert-geometry',
    'insert-point',
    'remove-point',
    'add-guide',
    'remove-guide',
    'insert-load',
    'update-sketch-positions',
    'update-dimension',
    'update-dimension-expression',
    'undo',
    'redo',
  ]);

  constructor(
    private readonly project: () => string | null,
    private readonly currentFile: () => string | null = () => null,
    /** The last render's engine-owned rows; omitted (tests), no row is refused. */
    private readonly rows: () => GeneratedRows = () => GeneratedRows.NONE,
  ) {}

  /** The package that owns `file`, or null. */
  ownerOf(file: string | null | undefined): PackageLocation | null {
    if (typeof file !== 'string' || file === '') {
      return null;
    }
    const project = this.project();
    if (!project) {
      return null;
    }
    return PackageRoots.owner(file.replace(/^virtual:live-render:/, ''), project);
  }

  /** The refusal of the first of `files` an installed package owns, or null when none is. */
  refusal(...files: (string | null | undefined)[]): PackageReadOnlyError | null {
    for (const file of files) {
      const owner = this.ownerOf(file);
      if (owner) {
        return new PackageReadOnlyError(owner, file!.replace(/^virtual:live-render:/, ''));
      }
    }
    return null;
  }

  /** Answer 403 `{ success: false, reason }` when one of `files` is a package file; true when it did. */
  refuse(res: Response, ...files: (string | null | undefined)[]): boolean {
    const refusal = this.refusal(...files);
    if (!refusal) {
      return false;
    }
    PackageEditGuard.answer(res, refusal);
    return true;
  }

  /** The refusal of a write aimed at an engine-owned row — by its statement or by the row it names — or null. */
  rowRefusal(target: RowTarget): GeneratedReadOnlyError | null {
    return this.rows().refusal(target);
  }

  /**
   * Answer 403 `{ success: false, reason, code: 'generated-read-only' }`
   * when `target` is an engine-owned row; true when it did. A route that
   * acts before its edit (or sends a host message) asks first.
   */
  refuseRow(res: Response, target: RowTarget): boolean {
    const refusal = this.rowRefusal(target);
    if (!refusal) {
      return false;
    }
    PackageEditGuard.answer(res, refusal);
    return true;
  }

  /**
   * Why an edit spec may not be sent: its file is a package's (K8), or the
   * row it rewrites is engine-owned — the statement of its row edit
   * ({@link rowTargetOf}) or the `row` it names. Null when it may.
   */
  specRefusal(spec: { filePath?: string; row?: unknown } & Record<string, any>): PackageReadOnlyError | GeneratedReadOnlyError | null {
    return this.refusal(spec.filePath) ?? this.rowRefusal(PackageEditGuard.rowTargetOf(spec));
  }

  /** Answer 403 when {@link specRefusal} refuses `spec`; true when it did. */
  refuseSpec(res: Response, spec: { filePath?: string; row?: unknown } & Record<string, any>): boolean {
    const refusal = this.specRefusal(spec);
    if (!refusal) {
      return false;
    }
    PackageEditGuard.answer(res, refusal);
    return true;
  }

  /**
   * The row an edit spec rewrites: the statement of its row edit — a part's
   * material, appearance or rename; an instance's pose, rename,
   * transparency or values; a removed statement — in its file, and the
   * `row` the route was told. Empty for every other edit.
   */
  static rowTargetOf(spec: { filePath?: string; row?: unknown } & Record<string, any>): RowTarget {
    const line: unknown = spec.partMaterial?.sourceLine
      ?? spec.partAppearance?.sourceLine
      ?? spec.partRename?.sourceLine
      ?? spec.instancePose?.sourceLine
      ?? spec.instanceRename?.sourceLine
      ?? spec.instanceTransparency?.sourceLine
      ?? spec.insertParams?.line
      ?? spec.removeFeature?.statement?.line;
    const location: RowLocation | null = typeof spec.filePath === 'string' && Number.isInteger(line)
      ? { filePath: spec.filePath, line: line as number }
      : null;
    return { location, row: spec.row };
  }

  /** The statement a host message rewrites a row at: a chain edit's `sourceLocation`, a removal's or a rename's `filePath` and `line`. */
  private static messageLocation(message: HostMessage): RowLocation | null {
    if (message.type === 'update-insert-chain') {
      const at = message.sourceLocation;
      return at && typeof at.filePath === 'string' && Number.isInteger(at.line) ? { filePath: at.filePath, line: at.line } : null;
    }
    if ((message.type === 'remove-feature' || message.type === 'rename-feature')
      && typeof message.filePath === 'string' && Number.isInteger(message.line)) {
      return { filePath: message.filePath, line: message.line };
    }
    return null;
  }

  /**
   * The files a host message edits: the ones it names (`filePath`,
   * `spec.filePath`, `sourceLocation.filePath`), else the open file, which
   * is what a message naming none edits. None for a message that edits no
   * source (not in {@link EDITS}).
   */
  targetsOf(message: HostMessage | null | undefined): string[] {
    if (!message || typeof message !== 'object' || !PackageEditGuard.EDITS.has(message.type)) {
      return [];
    }
    const named = [message.filePath, message.spec?.filePath, message.sourceLocation?.filePath]
      .filter((file): file is string => typeof file === 'string' && file !== '');
    if (named.length > 0) {
      return named;
    }
    const current = this.currentFile();
    return current ? [current] : [];
  }

  /**
   * `send`, refusing a message aimed at a package file: it throws
   * {@link PackageReadOnlyError} instead of sending, which the route's
   * request turns into a 403 through {@link errorHandler}.
   */
  guardSend(send: HostSend): HostSend {
    return (msg: any): boolean => {
      const refusal = this.refusal(...this.targetsOf(msg))
        ?? (msg && typeof msg === 'object' ? this.rowRefusal({ location: PackageEditGuard.messageLocation(msg) }) : null);
      if (refusal) {
        throw refusal;
      }
      return send(msg);
    };
  }

  /** Express error middleware answering a thrown {@link PackageReadOnlyError} or {@link GeneratedReadOnlyError} with 403 `{ success: false, reason, code }`. */
  static errorHandler(): ErrorRequestHandler {
    return (err, _req, res, next) => {
      if ((err instanceof PackageReadOnlyError || err instanceof GeneratedReadOnlyError) && !res.headersSent) {
        PackageEditGuard.answer(res, err);
        return;
      }
      next(err);
    };
  }

  private static answer(res: Response, refusal: PackageReadOnlyError | GeneratedReadOnlyError): void {
    const { status, reason, code } = PackageEditGuard.answerOf(refusal);
    res.status(status).json({ success: false, reason, code });
  }

  /** A refusal as the request it refuses is answered: 403, its sentence, and `generated-read-only` or `package-read-only`. */
  static answerOf(refusal: PackageReadOnlyError | GeneratedReadOnlyError): { status: number; reason: string; code: string } {
    const code = refusal instanceof GeneratedReadOnlyError ? GeneratedReadOnlyError.CODE : 'package-read-only';
    return { status: 403, reason: refusal.message, code };
  }
}
