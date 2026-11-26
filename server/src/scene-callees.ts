// A file's feature callees with the rendered scene's answers about its statements.

import type { FeatureCalleeSource, FeatureCallees, StatementProduct } from './apply-feature-edit/index.ts';

/** The part of the server that answers what a statement left in the rendered scene. */
export type StatementProductSource = {
  statementProduct(loc: { filePath: string; line: number; column?: number }): StatementProduct | null;
};

/**
 * A file's feature callees read over the rendered scene: what the catalog
 * says its calls build, plus what the last render says its statements left.
 * A wire input (a sweep path, a loft guide, an edge plane's base) may then
 * name any statement that left a curve — an imported one, a repeat of one,
 * a curve tool's result — without a list of callees to keep.
 *
 * Every code path that binds a producer takes its callees from one source:
 * the routes' previews, the dispatcher's dry run and the editor's round
 * trip. They share this one, so the three agree on what binds.
 */
export class SceneCallees implements FeatureCalleeSource {
  constructor(
    private readonly callees: FeatureCalleeSource,
    private readonly scene: StatementProductSource,
  ) {}

  async calleesFor(code: string, filePath: string): Promise<FeatureCallees> {
    const callees = await this.callees.calleesFor(code, filePath);
    return callees.over({
      at: site => this.scene.statementProduct({ filePath, line: site.line, column: site.column }),
    });
  }
}
