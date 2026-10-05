import type { KernelTrapReport } from '../../lib/dist/index.js';
import type { ObjectBuildError } from './fluidcad-server/render-types.ts';
import type { ServerToUIMessage, UIEngineSuspectMessage } from './ws-protocol.ts';

/** What the catalog says of a feature type: its label, and whether its module reaches raw OpenCascade. */
export type FeatureDisclosure = { label: string; usesOcct: boolean };

/** The slice of the kernel's trap registry (`KernelTraps`) the health watch reads. */
export type KernelTrapSource = {
  onTrap(listener: (report: KernelTrapReport) => void): () => void;
  isTrap(error: unknown): boolean;
  record(error: unknown, source: { type?: string | null; name?: string | null; during: KernelTrapReport['during'] }): KernelTrapReport;
};

/**
 * How the page can bring a fresh engine up. `exit`: the process that
 * forked this engine starts a new one, on the same port, when this one exits
 * with `exitCode` (`fluidcad serve` says so through
 * {@link EngineHealth.RESTART_EXIT_CODE_ENV}); the page reconnects to it by
 * itself. `none`: the engine can't restart itself — the banner says how.
 */
export type EngineRestart = { kind: 'exit'; exitCode: number } | { kind: 'none' };

export type EngineHealthOptions = {
  broadcast: (msg: ServerToUIMessage) => void;
  /** The catalog's word on a feature type; null for one it doesn't list (a built-in statement). */
  feature: (type: string) => Promise<FeatureDisclosure | null>;
  /** Defaults to what the environment says ({@link EngineHealth.restartFromEnv}). */
  restart?: EngineRestart;
};

/** A rendered row as the health watch reads and rewrites it. */
type TrapRow = { type?: string; name?: string; hasError?: boolean; kernelTrap?: boolean; errorMessage?: string };

/**
 * Whether the engine can still be trusted. The OpenCascade kernel trapped
 * (a wasm `RuntimeError`, reported through `KernelTraps`) means its heap
 * may be corrupt — most likely a custom feature's raw OpenCascade code
 * (`fluidcad/sdk/occt`) freed or reached memory the engine still needed —
 * and nothing the engine builds afterwards can be trusted until it
 * restarts. The engine marks itself **suspect** for the rest of its life and
 * tells every page (`engine-suspect`, UI-only), which offers the restart
 * this host supports.
 *
 * It also finishes the row error of a statement whose build trapped: when
 * the statement's feature reaches raw OpenCascade, the row names that as
 * the likeliest cause.
 */
export class EngineHealth {
  /** The environment variable a host that restarts its engine on a given exit code sets to that code. */
  static readonly RESTART_EXIT_CODE_ENV = 'FLUIDCAD_RESTART_EXIT_CODE';

  private suspectMessage: UIEngineSuspectMessage | null = null;
  private traps = 0;
  /** The editor host attached over IPC, which says how to restart when the engine can't. */
  private editor: string | null = null;
  private readonly explained = new WeakSet<object>();
  private readonly restart: EngineRestart;

  constructor(private readonly options: EngineHealthOptions) {
    this.restart = options.restart ?? EngineHealth.restartFromEnv(process.env);
  }

  /** What the environment says about restarting: an exit code a host restarts on, or nothing. */
  static restartFromEnv(env: NodeJS.ProcessEnv): EngineRestart {
    const code = Number.parseInt(env[EngineHealth.RESTART_EXIT_CODE_ENV] ?? '', 10);
    return Number.isInteger(code) && code > 0 && code < 256 ? { kind: 'exit', exitCode: code } : { kind: 'none' };
  }

  /** The suspect report every page is shown, or null while the engine is sound. */
  get suspect(): UIEngineSuspectMessage | null {
    return this.suspectMessage;
  }

  /** The exit code this engine's host restarts it on, or null when it can't restart itself. */
  get restartExitCode(): number | null {
    return this.restart.kind === 'exit' ? this.restart.exitCode : null;
  }

  /** How to restart this engine by hand, for the host that runs it. */
  get restartHint(): string {
    return EngineHealth.restartHint(this.editor);
  }

  /** Hear of every trap the kernel reports from now on. Returns the unsubscribe. */
  watch(traps: Pick<KernelTrapSource, 'onTrap'>): () => void {
    return traps.onTrap(report => {
      void this.noteTrap(report);
    });
  }

  /** The editor host that announced itself over IPC (`vscode`, `neovim`), for the restart hint. */
  noteEditor(editor: unknown): void {
    this.editor = typeof editor === 'string' ? editor : null;
    if (this.suspectMessage) {
      this.publish({ ...this.suspectMessage, ...this.restartFields() });
    }
  }

  /**
   * A render threw out of the engine. A trap — outside any one statement's
   * build: in meshing, disposal, the compare — is recorded like any other
   * (the watch then marks the engine suspect). Answers whether it was one.
   */
  noteError(error: unknown, traps: KernelTrapSource): boolean {
    if (!traps.isTrap(error)) {
      return false;
    }
    traps.record(error, { during: 'render' });
    return true;
  }

  /** The kernel trapped: mark the engine suspect and tell every page. */
  async noteTrap(report: KernelTrapReport): Promise<void> {
    this.traps++;
    const disclosure = report.type ? await this.featureOf(report.type) : null;
    // The first trap is the likeliest cause of any that follow; later ones
    // only bump the count.
    if (this.suspectMessage) {
      this.publish({ ...this.suspectMessage, traps: this.traps });
      return;
    }
    const who = report.name ?? disclosure?.label ?? null;
    const usesOcct = disclosure?.usesOcct === true;
    const what = report.during === 'preview' ? `${who}'s preview` : who;
    const sentences = [
      what ? `${what} crashed the OpenCascade kernel (${report.message}).` : `The OpenCascade kernel crashed (${report.message}).`,
    ];
    if (usesOcct) {
      sentences.push(`${who} uses raw OpenCascade (fluidcad/sdk/occt), the likeliest cause.`);
    }
    sentences.push('The engine\'s memory may be damaged: restart it before you trust what it builds.');
    this.publish({
      type: 'engine-suspect',
      message: sentences.join(' '),
      featureType: report.type,
      featureName: who,
      usesOcct,
      traps: this.traps,
      ...this.restartFields(),
    });
  }

  /**
   * Finish the row errors of statements whose build trapped: a row whose
   * feature reaches raw OpenCascade names it as the likeliest cause. Each
   * row is finished once — a render served again from the cache carries its
   * rows as they were.
   */
  async explain(data: { result: unknown[]; objectErrors?: ObjectBuildError[] }): Promise<void> {
    const rows = (data.result as TrapRow[]).filter(row => row?.kernelTrap === true && row.hasError === true && !this.explained.has(row));
    for (const row of rows) {
      this.explained.add(row);
      const disclosure = row.type ? await this.featureOf(row.type) : null;
      if (!disclosure?.usesOcct || !row.errorMessage) {
        continue;
      }
      const note = EngineHealth.rawOcctNote(row.name || disclosure.label);
      const index = data.result.indexOf(row);
      const objectError = data.objectErrors?.find(error => error.index === index);
      if (objectError && objectError.message === row.errorMessage) {
        objectError.message += note;
      }
      row.errorMessage += note;
    }
  }

  /** Send the suspect report, if any, to a page that just connected. */
  replay(send: (msg: ServerToUIMessage) => void): void {
    if (this.suspectMessage) {
      send(this.suspectMessage);
    }
  }

  /** What a trapped row adds when its feature reaches raw OpenCascade. */
  static rawOcctNote(name: string): string {
    return `\n${name} uses raw OpenCascade (fluidcad/sdk/occt) — the likeliest cause: its code freed, or reached past, memory the engine still needed.`;
  }

  private publish(message: UIEngineSuspectMessage): void {
    this.suspectMessage = message;
    this.options.broadcast(message);
  }

  /** How this host restarts: the engine itself, or a sentence saying how. */
  private restartFields(): Pick<UIEngineSuspectMessage, 'restart' | 'hint'> {
    if (this.restart.kind === 'exit') {
      return { restart: 'engine', hint: null };
    }
    return { restart: null, hint: EngineHealth.restartHint(this.editor) };
  }

  /** How to restart an engine that can't restart itself, by the editor host that runs it. */
  static restartHint(editor: string | null): string {
    if (editor === 'vscode') {
      return 'Restart the engine: run "Developer: Reload Window" in VS Code.';
    }
    if (editor === 'neovim') {
      return 'Restart the engine: run :FluidCadStop, then :FluidCadStart, in Neovim.';
    }
    return 'Restart the engine: close the project and open it again, or restart the command that serves this page.';
  }

  private async featureOf(type: string): Promise<FeatureDisclosure | null> {
    try {
      return await this.options.feature(type);
    } catch {
      return null;
    }
  }
}
