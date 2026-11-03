import { basename } from 'path';
import { normalizePath } from './normalize-path.ts';

/** A statement a write addresses: its file and 1-based line. */
export type RowLocation = { filePath: string; line: number };

/**
 * What a write is aimed at, as far as a route can tell: the statement it
 * would rewrite, and — when the page says so — the id of the row it comes
 * from (an instance, an occurrence, a mate or a relation of the assembly
 * view; `asm-0/inst-2`).
 */
export type RowTarget = { location?: RowLocation | null; row?: unknown };

/** A write aimed at a row the engine owns, refused (G8). */
export class GeneratedReadOnlyError extends Error {
  /** What the refusal answers with: `{ success: false, reason, code }`, status 403. */
  static readonly CODE = 'generated-read-only';

  constructor(message: string) {
    super(message);
    this.name = 'GeneratedReadOnlyError';
  }
}

/** One engine-owned row, as a refusal names it. */
type OwnedRow = { name: string; owner: string };

/** The slice of a render's assembly records the rule reads. */
export type GeneratedRecords = {
  instances?: readonly any[];
  occurrences?: readonly any[];
  mates?: readonly any[];
  relations?: readonly any[];
};

/**
 * The rows a render shows that the engine owns (G8): every part a generated
 * definition makes, and every record a generator's layout makes. No
 * statement of the user's declares them, so the editor writes nothing on
 * them — no material, appearance, rename, grounding, delete, pose,
 * transparency or values — and a write aimed at one is refused with one
 * sentence, as a package's file is (K8, `PackageEditGuard`).
 *
 * Two ways a write can be aimed at one, and the rule for each:
 * - **By its statement.** An engine-owned part is located at its
 *   definition's call — `defineAssembly()` for a generator's part
 *   templates (and, rendering the defining file on its own, for its
 *   instances), `definePart()` for a generated part — so a write whose
 *   statement is the location of a generated part row is refused: it would
 *   rewrite the definition (a `.material()` on `definePart()`, deleting the
 *   `defineAssembly()` export). A user's `insert()` is never such a
 *   location, so the occurrence a generator fills stays editable.
 * - **By its row.** Inside an occurrence, a layout's records share the
 *   location of the occurrence's own `insert()`, so their statement can't
 *   tell them apart from it; a route that is told the row (`row`, the id
 *   the assembly view keys it by) refuses an instance a generator made
 *   (`generatedBy`) and any record owned by a generated occurrence (its id
 *   path under the occurrence's, `asm-0/inst-2`).
 *
 * Built from each render's serialized rows and assembly records
 * ({@link of}); answers from the last one.
 */
export class GeneratedRows {
  static readonly NONE = new GeneratedRows(new Map(), new Map(), []);

  private constructor(
    /** `file\0line` of every generated part row's location → the sentence a write aimed there is refused with. */
    private readonly sites: ReadonlyMap<string, string>,
    /** Every engine-owned record by id: an instance a generator made, and any record a generated occurrence owns. */
    private readonly instances: ReadonlyMap<string, OwnedRow>,
    /** Every generated occurrence: its id (a scope path) and name. */
    private readonly occurrences: readonly { id: string; name: string; definition: string }[],
  ) {}

  /** The engine-owned rows of one render: its serialized `objects` and its assembly records (null for a part render). */
  static of(objects: readonly any[], records: GeneratedRecords | null): GeneratedRows {
    const sites = new Map<string, string>();
    for (const row of objects) {
      const object = row?.object;
      const location = row?.sourceLocation;
      if (row?.type !== 'part' || !object || !location || (!object.generatedBy && !object.generated)) {
        continue;
      }
      const file = basename(String(location.filePath));
      // A generator's templates all stand at its defineAssembly() call: the
      // refusal names the definition, not one of them.
      sites.set(GeneratedRows.key(location), object.generatedBy
        ? `The parts of the generated assembly '${object.generatedBy.definition}' (${file}) are read-only: change them through the values of the insert that makes them.`
        : GeneratedRows.sentence({ name: String(row.name ?? object.name ?? 'This part'), owner: `the generated part '${object.generated.definition}'` }, file));
    }
    const occurrences = (records?.occurrences ?? [])
      .filter(occ => occ?.generated && typeof occ.occurrenceId === 'string')
      .map(occ => ({ id: occ.occurrenceId as string, name: String(occ.name ?? occ.assemblyName), definition: String(occ.generated.definition) }));
    const ownerOf = (id: string) => occurrences.find(occ => id.startsWith(`${occ.id}/`)) ?? null;
    const instances = new Map<string, OwnedRow>();
    const note = (id: unknown, name: unknown, generatedBy?: { definition: string }) => {
      if (typeof id !== 'string') {
        return;
      }
      const occurrence = ownerOf(id);
      if (occurrence) {
        instances.set(id, { name: String(name ?? GeneratedRows.leafOf(id)), owner: `the generated assembly '${occurrence.name}'` });
      } else if (generatedBy) {
        instances.set(id, { name: String(name ?? GeneratedRows.leafOf(id)), owner: `the generated assembly '${generatedBy.definition}'` });
      }
    };
    for (const inst of records?.instances ?? []) {
      note(inst?.instanceId, inst?.name ?? inst?.partName, inst?.generatedBy);
    }
    for (const occ of records?.occurrences ?? []) {
      note(occ?.occurrenceId, occ?.name ?? occ?.assemblyName);
    }
    for (const mate of records?.mates ?? []) {
      note(mate?.mateId, mate?.name);
    }
    for (const relation of records?.relations ?? []) {
      note(relation?.relationId, relation?.name);
    }
    if (sites.size === 0 && instances.size === 0 && occurrences.length === 0) {
      return GeneratedRows.NONE;
    }
    return new GeneratedRows(sites, instances, occurrences);
  }

  /** Whether the render had any engine-owned row. */
  get isEmpty(): boolean {
    return this.sites.size === 0 && this.instances.size === 0 && this.occurrences.length === 0;
  }

  /** The refusal of a write aimed at `target`, or null when it addresses no engine-owned row. */
  refusal(target: RowTarget): GeneratedReadOnlyError | null {
    if (target.location && typeof target.location.filePath === 'string' && Number.isInteger(target.location.line)) {
      const site = this.sites.get(GeneratedRows.key(target.location));
      if (site) {
        return new GeneratedReadOnlyError(site);
      }
    }
    if (typeof target.row === 'string' && target.row !== '') {
      const instance = this.instances.get(target.row);
      if (instance) {
        return GeneratedRows.refuse(instance);
      }
      const occurrence = this.occurrences.find(occ => target.row !== occ.id && (target.row as string).startsWith(`${occ.id}/`));
      if (occurrence) {
        return GeneratedRows.refuse({ name: GeneratedRows.leafOf(target.row), owner: `the generated assembly '${occurrence.name}'` });
      }
    }
    return null;
  }

  private static refuse(row: OwnedRow): GeneratedReadOnlyError {
    return new GeneratedReadOnlyError(GeneratedRows.sentence(row));
  }

  private static sentence(row: OwnedRow, file?: string): string {
    const where = file ? ` (${file})` : '';
    return `'${row.name}' is made by ${row.owner}${where} and is read-only: change it through the values of the insert that makes it.`;
  }

  /** A row id's last segment (`asm-0/mate-1` → `mate-1`), what a refusal calls a record it has no name for. */
  private static leafOf(id: string): string {
    return id.slice(id.lastIndexOf('/') + 1);
  }

  private static key(location: RowLocation): string {
    return `${normalizePath(location.filePath.replace(/^virtual:live-render:/, ''))}\u0000${location.line}`;
  }
}
