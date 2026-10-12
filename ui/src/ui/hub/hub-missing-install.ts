import type { HubClient, PackageInstallOutcome, PackageTarget } from '../../api';
import type { PackageConsentDialog } from '../packages/package-consent-dialog';

/** A pin the project needs and nothing holds, as the banner and the Packages dialog name it. */
export type MissingPin = { name: string; version: string | null };

export type HubMissingInstallDeps = {
  hub: HubClient;
  consent: PackageConsentDialog;
  /** Settings → Packages' "New packages go to". */
  installSetting(): PackageTarget;
  projectOpen(): boolean;
  /** The download is running (the banner's button waits). */
  onBusy?(busy: boolean): void;
  /** Something refused before the consent dialog: the sentence to show. */
  onError(message: string): void;
  onInstalled(outcome: PackageInstallOutcome): void;
};

/**
 * The missing-package banner's "Install from the hub" (hub-plan H11; the
 * user confirmed on 2026-10-10 that it keeps the consent dialog, and the
 * 2026-10-12 decisions didn't change that): download and check the pinned
 * version (`POST /api/hub/inspect`, checked against the pin), show the
 * consent dialog with it, then install and keep the pin. It never opens
 * the Hub panel. Replace in the dialog downloads it again for the chosen
 * target.
 */
export class HubMissingInstall {
  private running = false;

  constructor(private readonly deps: HubMissingInstallDeps) {}

  get busy(): boolean {
    return this.running;
  }

  async run(pin: MissingPin): Promise<PackageInstallOutcome | null> {
    if (this.running) {
      return null;
    }
    this.running = true;
    this.deps.onBusy?.(true);
    const projectOpen = this.deps.projectOpen();
    const setting = this.deps.installSetting();
    const target: PackageTarget = setting === 'project' && projectOpen ? 'project' : 'library';
    let inspected;
    try {
      inspected = await this.deps.hub.inspect({ name: pin.name, version: pin.version, target });
    } finally {
      this.running = false;
      this.deps.onBusy?.(false);
    }
    if (inspected.ok === false) {
      this.deps.onError(HubMissingInstall.refusal(inspected.code, inspected.error, pin));
      return null;
    }
    const inspection = inspected.inspection;
    const outcome = await this.deps.consent.open({
      inspection,
      projectOpen,
      pin: projectOpen,
      note: inspection.notes.length > 0 ? inspection.notes.join(' ') : undefined,
      reinspect: async (again) => {
        const answer = await this.deps.hub.inspect({ name: pin.name, version: pin.version, target: again });
        return answer.ok === false ? answer : { ok: true, inspection: answer.inspection };
      },
    });
    if (outcome) {
      this.deps.onInstalled(outcome);
    }
    return outcome;
  }

  /** The panel's words for a download that never reached the dialog. */
  static refusal(code: string | undefined, error: string, pin: MissingPin): string {
    const label = pin.version ? `${pin.name} ${pin.version}` : pin.name;
    if (code === 'hub-unreachable') {
      return `Couldn't reach the hub to download ${label}. Check the connection and try again.`;
    }
    if (code === 'not-found' || code === 'nothing-published') {
      return `${label} isn't on the hub, so it can't be downloaded. ${error}`;
    }
    return error;
  }
}
