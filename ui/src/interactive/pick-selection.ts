import { ApplyFeatureChain } from '../api';
import { entityKey, mergeUniqueEntities, sameEntity, selectionChipRows } from '../helpers/entities';
import { SelectedEntity } from '../viewer';

/**
 * The chain-aware pick set the multi-pick tools share (fillet/chamfer/shell,
 * the sweep path): plain picks accumulate; a tangent chain owns its members
 * (it synthesizes to `.withTangents()`), so a member click toggles the whole
 * chain and an overlapping chain replaces older picks. The fields stay
 * public — services seed and filter them directly on renders.
 */
export class PickSelection {
  entities: SelectedEntity[] = [];
  chains: { seed: SelectedEntity; members: SelectedEntity[] }[] = [];

  get isEmpty(): boolean {
    return this.entities.length === 0;
  }

  clear(): void {
    this.entities = [];
    this.chains = [];
  }

  /** Toggle a plain pick; a chain member toggles its whole chain off. */
  toggle(entity: SelectedEntity): void {
    const chain = this.chains.find(c => c.members.some(m => sameEntity(m, entity)));
    if (chain) {
      const memberKeys = new Set(chain.members.map(entityKey));
      this.entities = this.entities.filter(e => !memberKeys.has(entityKey(e)));
      this.chains = this.chains.filter(c => c !== chain);
    } else {
      const existing = this.entities.findIndex(e => sameEntity(e, entity));
      if (existing >= 0) {
        this.entities = this.entities.filter((_, i) => i !== existing);
      } else {
        this.entities = [...this.entities, entity];
      }
    }
  }

  /** Merge group members as plain picks; false when nothing was new. */
  merge(members: SelectedEntity[]): boolean {
    const merged = mergeUniqueEntities(this.entities, members);
    if (merged.length === this.entities.length) {
      return false;
    }
    this.entities = merged;
    return true;
  }

  /** Record a tangent chain: it owns its members, replacing overlapping picks. */
  addChain(seed: SelectedEntity, members: SelectedEntity[]): void {
    const memberKeys = new Set(members.map(entityKey));
    this.chains = this.chains.filter(c => !c.members.some(m => memberKeys.has(entityKey(m))));
    this.entities = [
      ...this.entities.filter(e => !memberKeys.has(entityKey(e))),
      ...members,
    ];
    this.chains.push({ seed, members });
  }

  /**
   * Drop non-face picks (a face-only tool armed over carried-over edges);
   * chains losing a member go with them.
   */
  restrictToFaces(): void {
    const faces = this.entities.filter(e => e.sub.type === 'face');
    if (faces.length === this.entities.length) {
      return;
    }
    const faceKeys = new Set(faces.map(entityKey));
    this.chains = this.chains.filter(c => c.members.every(m => faceKeys.has(entityKey(m))));
    this.entities = faces;
  }

  /** The removable chip rows: one per plain pick, a chain as a single row. */
  chipRows(): { label: string; members: SelectedEntity[] }[] {
    return selectionChipRows(this.entities, this.chains);
  }

  /** Sorted signature of the pick set, for dirty detection. */
  signature(): string {
    return this.entities.map(entityKey).sort().join('|');
  }

  apiChains(): ApplyFeatureChain[] {
    return this.chains.map(c => ({ seed: c.seed, members: c.members }));
  }
}
