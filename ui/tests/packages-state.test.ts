import { describe, it, expect } from 'vitest';
import { PackagesState } from '../src/ui/packages/packages-state';
import { FakePackagesClient, settle } from './fixtures/fake-packages-client';

// The page's one copy of `GET /api/packages`, and what it says about the
// open workspace itself (ui-packages-plan N1): whether it is a package, so
// the top bar's Share becomes Publish (U6), a broken block included (U7).

async function stateWith(overview: Parameters<typeof FakePackagesClient.overview>[0] | null): Promise<PackagesState> {
  const client = new FakePackagesClient(overview === null ? null : FakePackagesClient.overview(overview));
  const state = new PackagesState(client);
  await state.refresh();
  await settle();
  return state;
}

describe('PackagesState: the workspace as a package', () => {
  it('is not a package workspace before the overview arrives', () => {
    const state = new PackagesState(new FakePackagesClient(FakePackagesClient.overview()));
    expect(state.isPackageWorkspace).toBe(false);
    expect(state.package).toBeNull();
    expect(state.packageProblem).toBeNull();
  });

  it('is not a package workspace for a plain project, or when the engine answers nothing', async () => {
    expect((await stateWith({})).isPackageWorkspace).toBe(false);
    expect((await stateWith(null)).isPackageWorkspace).toBe(false);
  });

  it('is a package workspace with the block, and exposes its name and version', async () => {
    const state = await stateWith({ package: { name: '@acme/kit', version: '0.1.0' } });
    expect(state.isPackageWorkspace).toBe(true);
    expect(state.package).toEqual({ name: '@acme/kit', version: '0.1.0' });
    expect(state.packageProblem).toBeNull();
  });

  it('is a package workspace on a block the engine cannot read, with the problem and no identity (U7)', async () => {
    const problem = 'fluidcad.json has a "package" whose "name" "kit" needs your hub handle as its scope: write "@<your-handle>/kit".';
    const state = await stateWith({ package: null, packageProblem: problem });
    expect(state.isPackageWorkspace).toBe(true);
    expect(state.package).toBeNull();
    expect(state.packageProblem).toBe(problem);
  });

  it('follows the overview: a block that vanishes makes it a plain project again', async () => {
    const client = new FakePackagesClient(FakePackagesClient.overview({ package: { name: '@acme/kit', version: '0.1.0' } }));
    const state = new PackagesState(client);
    const seen: boolean[] = [];
    state.subscribe(() => seen.push(state.isPackageWorkspace));
    await state.refresh();
    client.overviewValue = FakePackagesClient.overview({ package: null });
    await state.refresh();
    expect(seen).toEqual([true, false]);
  });
});
