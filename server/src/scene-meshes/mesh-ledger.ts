/**
 * What one page connection was sent recently: mesh keys, least recently
 * sent first, each with its weight (`SceneMeshes.weightOf`, a count of
 * numbers). Bounded by a total weight and a count; dropped with the
 * connection. Holds keys and numbers only — never a mesh, never a kernel
 * object.
 *
 * **The rule (S6b).** The ledger is an assumption, not a mirror: the page
 * never reports what it evicts. The server sends `meshRef` only for keys
 * sent on this connection *recently* — within a weight that is half the
 * capacity the page announced (`ui-hello.meshCache.capacity`). The page
 * keeps at least its capacity's worth of the most recently used keys (and
 * every key on screen), touching them in the order the scenes bring them,
 * so a key this ledger still holds is, in all but a race, one the page
 * holds; the half is margin for keys the page keeps that this ledger never
 * saw (meshes it fetched, keys from an earlier connection). When the page
 * misses anyway it asks `POST /api/meshes` — the fallback, which a reported
 * eviction would need just the same for the eviction racing a scene in
 * flight. A server that evicts early only sends a payload again.
 */
export class MeshLedger {
  /** The weight a ledger keeps when the page announced no capacity (before its hello). */
  static readonly DEFAULT_CAPACITY = 2_000_000;
  /** The most keys one ledger keeps, whatever their weight. */
  static readonly MAX_ENTRIES = 50_000;

  /** key → weight, in the order the keys were last sent (oldest first). */
  private readonly held = new Map<string, number>();
  private weight = 0;

  constructor(private capacity: number = MeshLedger.DEFAULT_CAPACITY) {}

  /**
   * The ledger for a page that announced it keeps `pageCapacity` numbers'
   * worth of meshes: half of it, never more than the default.
   */
  static forPage(pageCapacity: number): MeshLedger {
    return new MeshLedger(Math.min(MeshLedger.DEFAULT_CAPACITY, Math.floor(pageCapacity / 2)));
  }

  /**
   * The capacity a `ui-hello`'s `meshCache` announces — how many numbers'
   * worth of meshes the page keeps — or null when it announces none (or
   * nothing usable): that page is sent whole scenes.
   */
  static announcedCapacity(meshCache: unknown): number | null {
    const capacity = (meshCache as { capacity?: unknown } | null | undefined)?.capacity;
    return typeof capacity === 'number' && Number.isFinite(capacity) && capacity > 0 ? capacity : null;
  }

  /** Every key this ledger holds, oldest first, noted in `target` (within its own bounds). */
  transferTo(target: MeshLedger): void {
    for (const [key, weight] of this.held) {
      target.note(key, weight);
    }
  }

  /** Whether `key` was sent on this connection recently enough to count as held. */
  holds(key: string): boolean {
    return this.held.has(key);
  }

  /** `key` was sent (as a payload or a reference): the most recent now. Trims past the bounds. */
  note(key: string, weight: number): void {
    const known = this.held.get(key);
    if (known !== undefined) {
      this.held.delete(key);
      this.weight -= known;
    }
    this.held.set(key, weight);
    this.weight += weight;
    this.trim();
  }

  get size(): number {
    return this.held.size;
  }

  get totalWeight(): number {
    return this.weight;
  }

  get maxWeight(): number {
    return this.capacity;
  }

  private trim(): void {
    for (const [key, weight] of this.held) {
      if (this.weight <= this.capacity && this.held.size <= MeshLedger.MAX_ENTRIES) {
        return;
      }
      this.held.delete(key);
      this.weight -= weight;
    }
  }
}
