import { vi } from 'vitest';
import type {
  HubAppPublishPackage,
  HubAppPublishRequest,
  HubAppPublishState,
  HubPublishStatus,
  HubPublishSummary,
  HubUploadResult,
  HubVersionStatus,
  PackageVersionChange,
  PublishClient,
  PublishRefusal,
  PublishResult,
} from '../../src/api';

export const HUB = 'http://localhost:8787';

/**
 * A {@link PublishClient} for the Publish dialog's tests (ui-packages-plan
 * N4): the engine's `PublishSession` as the routes answer it. `start`
 * opens a session in `packing`; the test plays the publisher with
 * {@link advance} (the summary, the progress, the result), and `confirm`
 * / `cancel` move it the way the engine does. Every route is a `vi.fn`,
 * and each has a refusal the test can set.
 */
export class FakePublishClient implements PublishClient {
  packageValue: HubAppPublishPackage = { package: { name: '@acme/kit', version: '0.1.0' }, problem: null };
  packageRefusal: PublishRefusal | null = null;
  statusValue: HubPublishStatus = FakePublishClient.status();
  statusRefusal: PublishRefusal | null = null;
  /** The engine's session, as `GET api/publish` answers it. */
  session: HubAppPublishState | null = null;
  startRefusal: PublishRefusal | null = null;
  /** What the preflight makes of the next start, merged into the new session (a `failed` with its error). */
  startOutcome: Partial<HubAppPublishState> | null = null;
  /** While set, `start()` waits for it: the test sees the buttons wait. */
  startGate: Promise<void> | null = null;
  withdrawRefusal: PublishRefusal | null = null;
  bumpRefusal: PublishRefusal | null = null;
  private starts = 0;

  packageInfo = vi.fn(async (): Promise<PublishResult<{ package: HubAppPublishPackage }>> => {
    if (this.packageRefusal) {
      return this.packageRefusal;
    }
    return { ok: true, package: { ...this.packageValue } };
  });

  status = vi.fn(async (): Promise<PublishResult<{ status: HubPublishStatus }>> => {
    if (this.statusRefusal) {
      return this.statusRefusal;
    }
    return { ok: true, status: structuredClone(this.statusValue) };
  });

  start = vi.fn(async (request: HubAppPublishRequest): Promise<PublishResult<{ publish: HubAppPublishState }>> => {
    if (this.startGate) {
      await this.startGate;
    }
    if (this.startRefusal) {
      return this.startRefusal;
    }
    this.session = FakePublishClient.state({
      id: `publish-${++this.starts}`,
      status: 'packing',
      dryRun: request.dryRun === true,
      notes: request.notes?.trim() ? request.notes.trim() : null,
      ...this.startOutcome,
    });
    return { ok: true, publish: { ...this.session } };
  });

  current = vi.fn(async (): Promise<PublishResult<{ publish: HubAppPublishState | null }>> => ({
    ok: true,
    publish: this.session ? { ...this.session } : null,
  }));

  confirm = vi.fn(async (): Promise<PublishResult<{ publish: HubAppPublishState }>> => {
    if (this.session?.status !== 'awaiting-confirm') {
      return { ok: false, status: 409, error: 'No publish is waiting to be confirmed.', code: 'nothing-to-confirm' };
    }
    this.advance({ status: 'uploading', confirmBy: null, progress: { sent: 0, total: this.session.summary?.size ?? 0 } });
    return { ok: true, publish: { ...this.session! } };
  });

  cancel = vi.fn(async (): Promise<PublishResult<{ publish: HubAppPublishState | null }>> => {
    if (this.session && ['checking', 'packing', 'awaiting-confirm'].includes(this.session.status)) {
      this.advance({ status: 'declined', confirmBy: null, progress: null, error: { code: 'cancelled', message: 'Publish cancelled. Nothing was uploaded.' } });
    }
    return { ok: true, publish: this.session ? { ...this.session } : null };
  });

  withdraw = vi.fn(async (): Promise<PublishResult<{ withdrawn: HubVersionStatus }>> => {
    if (this.withdrawRefusal) {
      return this.withdrawRefusal;
    }
    const open = this.statusValue.package?.openVersion;
    if (!open) {
      return { ok: false, status: 409, error: `${this.statusValue.name} has nothing open to withdraw.`, code: 'nothing-open' };
    }
    this.statusValue = { ...this.statusValue, package: { ...this.statusValue.package!, openVersion: null } };
    return { ok: true, withdrawn: open };
  });

  bumpVersion = vi.fn(async (spec: string): Promise<PublishResult<{ change: PackageVersionChange }>> => {
    if (this.bumpRefusal) {
      return this.bumpRefusal;
    }
    const pkg = this.packageValue.package!;
    const to = spec;
    if (!/^\d+\.\d+\.\d+$/.test(to)) {
      return { ok: false, status: 400, error: `"${spec}" is not a version or a bump: use major, minor, patch, or a version such as 1.2.0.`, code: 'refused' };
    }
    const change = { name: pkg.name, from: pkg.version, to, configPath: '/ws/fluidcad.json' };
    this.packageValue = { package: { ...pkg, version: to }, problem: null };
    return { ok: true, change };
  });

  /** The engine's publisher moves the session on. */
  advance(patch: Partial<HubAppPublishState>): void {
    this.session = { ...this.session!, ...patch };
  }

  static state(extra: Partial<HubAppPublishState> = {}): HubAppPublishState {
    return {
      id: 'publish-1',
      hub: HUB,
      status: 'packing',
      dryRun: false,
      notes: null,
      startedAt: '2026-10-24T12:00:00.000Z',
      confirmBy: null,
      summary: null,
      progress: null,
      result: null,
      error: null,
      ...extra,
    };
  }

  static summary(extra: Partial<HubPublishSummary> = {}): HubPublishSummary {
    return {
      hub: HUB,
      handle: 'acme',
      name: '@acme/kit',
      version: '0.1.0',
      size: 1100,
      files: 5,
      integrity: 'sha256-abc',
      contents: {
        features: [{ id: 'standoff', exportName: 'standoff', module: 'features/standoff.feature.js' }],
        parts: [{ exportName: 'part1', name: 'part1', module: 'parts/part1.part.js', params: 0 }],
        assemblies: [],
        models: 1,
        docs: [],
      },
      warnings: [],
      becomes: 'draft',
      replacesDraft: false,
      notes: null,
      dryRun: false,
      ...extra,
    };
  }

  static result(extra: Partial<HubUploadResult> = {}): HubUploadResult {
    return {
      name: '@acme/kit',
      version: '0.1.0',
      status: 'draft',
      wizardUrl: `${HUB}/publish/@acme/kit/0.1.0`,
      reviewUrl: null,
      integrity: 'sha256-abc',
      size: 1100,
      unpackedSize: 2400,
      replaced: false,
      dryRun: false,
      ...extra,
    };
  }

  static version(extra: Partial<HubVersionStatus> = {}): HubVersionStatus {
    return {
      name: '@acme/kit',
      version: '0.1.0',
      status: 'draft',
      wizardUrl: `${HUB}/publish/@acme/kit/0.1.0`,
      reviewUrl: `${HUB}/@acme/kit/status`,
      draftExpiresAt: null,
      submittedAt: null,
      publishedAt: null,
      reviewedAt: null,
      reviewNote: null,
      integrity: 'sha256-abc',
      notes: '',
      size: 1100,
      createdAt: '2026-10-24T12:00:00.000Z',
      updatedAt: '2026-10-24T12:00:00.000Z',
      ...extra,
    };
  }

  /** Not on the hub yet, by default. */
  static status(extra: Partial<HubPublishStatus> = {}): HubPublishStatus {
    return { name: '@acme/kit', package: null, latest: null, ...extra };
  }

  /** On the hub, with what `extra` says of it. */
  static onHub(extra: Partial<NonNullable<HubPublishStatus['package']>> = {}, latest: HubVersionStatus | null = null): HubPublishStatus {
    return {
      name: '@acme/kit',
      package: { name: '@acme/kit', status: 'active', openVersion: null, rejectedVersion: null, latestVersion: latest?.version ?? null, highestVersion: latest?.version ?? null, ...extra },
      latest,
    };
  }

  static signedOut(): PublishRefusal {
    return { ok: false, status: 401, error: `Not signed in to ${HUB}. Sign in to publish.`, code: 'signed-out', details: { reason: 'no-credentials' } };
  }
}
