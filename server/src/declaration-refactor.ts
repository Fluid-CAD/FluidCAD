// The cross-file half of a rename or delete — of a parameter or property
// from the parameters panel, of an instance from the parts panel: which
// workspace files read a declaration besides the one that declares it, what
// the edit does to each, and sending those edits through the editor host
// before the declaring file's own.

import type { Response } from 'express';
import type { FeatureEditDispatcher } from './edit-dispatch.ts';
import type { ApplyFeatureEditSpec } from './apply-feature-edit/index.ts';
import { WorkspaceScripts, type ScriptServer } from './workspace-scripts.ts';
import {
  appendFileReport,
  blockedReason,
  DeclarationUsages,
  fileReport,
  type DeclarationRef,
  type DeclarationReport,
  type UsageEditSpec,
  type UsageSite,
} from './declaration-usages.ts';

/** The slice of the server this reads: the rendered file, its text, and the host's other buffers. */
export type RefactorServer = ScriptServer;

/** One file that reads the declaration, with its reads. */
export type ConsumerFile = { filePath: string; usages: DeclarationUsages; sites: UsageSite[] };

/** An `ApplyFeatureEditSpec` that carries only a `usageEdit` to `filePath`. */
function usageSpec(filePath: string, usageEdit: UsageEditSpec): ApplyFeatureEditSpec {
  return { feature: 'sketch', filePath, producers: [], parts: [], imports: [], usageEdit };
}

export class DeclarationRefactor {
  private readonly scripts: WorkspaceScripts;

  constructor(
    server: RefactorServer,
    workspacePath: string,
    private readonly dispatcher: FeatureEditDispatcher,
  ) {
    this.scripts = new WorkspaceScripts(server, workspacePath);
  }

  /** A model file's text as the editor holds it — see {@link WorkspaceScripts.read}. */
  readFile(filePath: string): Promise<string | null> {
    return this.scripts.read(filePath);
  }

  /**
   * Every workspace script other than the declaring file that reads the
   * declaration. A file can only reach another through an import naming
   * it, so files that never mention the declaring file's name are not
   * even parsed.
   */
  async consumers(declaration: DeclarationRef): Promise<ConsumerFile[]> {
    const stem = declaration.filePath.split('/').pop()!.replace(/\.js$/, '');
    const out: ConsumerFile[] = [];
    for (const { filePath, code } of await this.scripts.others(declaration.filePath)) {
      if (!code.includes(stem)) {
        continue;
      }
      const usages = await DeclarationUsages.of(code, filePath, declaration);
      const sites = usages.sites();
      if (sites.length > 0) {
        out.push({ filePath, usages, sites });
      }
    }
    return out;
  }

  /** Fold every other file's reads into the declaring file's report. */
  async extendReport(report: DeclarationReport): Promise<DeclarationReport> {
    if (!report.declaration) {
      return report;
    }
    for (const consumer of await this.consumers(report.declaration)) {
      const blocked = report.portable ? [] : consumer.sites.filter((site) => site.kind !== 'override');
      appendFileReport(report, fileReport(consumer.filePath, consumer.sites, blocked));
    }
    return report;
  }

  /** The edits that follow a rename through every other file. */
  async renameSpecs(
    declaration: DeclarationRef,
    newKey: string,
    newVariable: string | null,
    newVariableExport: string | null,
  ): Promise<ApplyFeatureEditSpec[]> {
    const consumers = await this.consumers(declaration);
    return consumers.map((consumer) => usageSpec(consumer.filePath, {
      action: 'rename', declaration, newKey, newVariable, newVariableExport,
    }));
  }

  /**
   * The edits that stand the value in for every other file's reads of the
   * declaration, or why they cannot: a value that reads its own file's names
   * means nothing elsewhere, so any such read blocks the delete.
   */
  async inlineSpecs(
    declaration: DeclarationRef,
    value: string | null,
    portable: boolean,
  ): Promise<{ specs: ApplyFeatureEditSpec[] } | { error: string }> {
    const consumers = await this.consumers(declaration);
    if (!portable) {
      const blocked = consumers
        .map((consumer) => fileReport(consumer.filePath, consumer.sites, consumer.sites.filter((site) => site.kind !== 'override')))
        .flatMap((file) => file.blocked);
      if (blocked.length > 0) {
        return { error: blockedReason(declaration.kind, declaration.key, value, blocked) };
      }
    }
    return {
      specs: consumers.map((consumer) => usageSpec(consumer.filePath, {
        action: 'inline', declaration, expression: value ?? '', portable,
      })),
    };
  }

  /**
   * Send the other files' edits, one after another, before the declaring
   * file's. A refusal stops the sequence and is answered on `res` — the
   * declaring file is left as it was, so the model keeps building; the
   * files already edited say so in the reason.
   */
  async dispatchConsumers(res: Response, specs: ApplyFeatureEditSpec[]): Promise<boolean> {
    for (let i = 0; i < specs.length; i++) {
      const outcome = await this.dispatcher.send(specs[i]);
      if (outcome.error) {
        const done = i === 0 ? '' : ` (${i} other file${i === 1 ? '' : 's'} already updated)`;
        res.status(422).json({
          success: false,
          reason: `${specs[i].filePath.split('/').pop()}: ${outcome.error}${done}`,
        });
        return false;
      }
    }
    return true;
  }
}
