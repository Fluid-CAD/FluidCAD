import type { ErrorRequestHandler, Response } from 'express';
import { PackageRoots, type PackageLocation } from './package-roots.ts';

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
      const refusal = this.refusal(...this.targetsOf(msg));
      if (refusal) {
        throw refusal;
      }
      return send(msg);
    };
  }

  /** Express error middleware answering a thrown {@link PackageReadOnlyError} with 403 `{ success: false, reason }`. */
  static errorHandler(): ErrorRequestHandler {
    return (err, _req, res, next) => {
      if (err instanceof PackageReadOnlyError && !res.headersSent) {
        PackageEditGuard.answer(res, err);
        return;
      }
      next(err);
    };
  }

  private static answer(res: Response, refusal: PackageReadOnlyError): void {
    res.status(403).json({ success: false, reason: refusal.message, code: 'package-read-only' });
  }
}
