import { vi } from 'vitest';
import type {
  ChatSceneHost,
  ReferencePick,
  ResolveOutcome,
  ResolveSelectionAnswer,
  SelectedEntityLike,
} from '../../src/ui/chat/scene-references';
import rimEdges from './resolve-selection/plate-rim-edges.json';

/** A scene the composer attaches from: a selection, renders, a resolver answering from the recordings. */
export class FakeScene implements ChatSceneHost {
  entities: SelectedEntityLike[] = [];
  rolledBack = false;
  private selectionListeners = new Set<() => void>();
  private renderListeners = new Set<() => void>();
  resolveCalls: ReferencePick[][] = [];
  /** Answers by the picks' shape id and count; anything else is the rim-edges answer. */
  answers: (picks: ReferencePick[]) => ResolveOutcome = () => ({ ok: true, answer: rimEdges as ResolveSelectionAnswer });
  pending: { resolve: () => void } | null = null;
  hold = false;

  selection = () => this.entities;
  addSelectionListener = (fn: () => void) => {
    this.selectionListeners.add(fn);
    return () => this.selectionListeners.delete(fn);
  };
  addRenderListener = (fn: () => void) => {
    this.renderListeners.add(fn);
    return () => this.renderListeners.delete(fn);
  };
  clearSelection = () => this.select([]);
  isRolledBack = () => this.rolledBack;
  currentFile = () => '/w/plate.part.js';
  /** Why nothing can be picked from the model on screen (an assembly); null when it can. */
  unpickableReason: string | null = null;
  unpickable = () => this.unpickableReason;
  capture = vi.fn(async () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }));
  resolve = async (picks: ReferencePick[]): Promise<ResolveOutcome> => {
    this.resolveCalls.push(picks);
    if (this.hold) {
      await new Promise<void>((resolve) => {
        this.pending = { resolve };
      });
    }
    return this.answers(picks);
  };

  select(entities: SelectedEntityLike[]): void {
    this.entities = entities;
    for (const fn of [...this.selectionListeners]) {
      fn();
    }
  }

  render(): void {
    this.entities = [];
    for (const fn of [...this.renderListeners]) {
      fn();
    }
  }
}

export const edges = (n: number): SelectedEntityLike[] =>
  Array.from({ length: n }, (_, i) => ({ shapeId: 'sh-1', sub: { type: 'edge', index: i } }));
export const face = (index = 9): SelectedEntityLike => ({ shapeId: 'sh-1', sub: { type: 'face', index } });
