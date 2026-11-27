import { vi } from 'vitest';
import type { ApplyFeatureEntity, SelectionGroup } from '../../src/api';

type Answer = unknown | { error: string };

/**
 * The server a pick dialog talks to, at the network: `fetch` is stubbed
 * and answers the selection routes from the fields below, the
 * apply-feature preview with a statement, and anything else as a failure,
 * which every api function survives. The tests drive the services through
 * the real api functions so that they hold whichever test file first
 * loaded those services in the shared worker (`isolate: false`): a module
 * mock binds a service to the first file that mocked it, a stubbed network
 * reaches every binding. No test file may mock `expandLoop`, `expandBucket`
 * or `fetchSelectionGroups` for that reason.
 */
export class FakeSelectionServer {
  /** `/selection/expand-loop`: not on a rim unless a test says so. */
  loop: (entity: ApplyFeatureEntity) => Answer = () => ({ rim: false, members: [] });
  /** `/selection/expand-bucket`: no bucket unless a test says so (a loaded surface has none). */
  bucket: (entity: ApplyFeatureEntity) => Answer = () => ({ error: 'this pick has no classified bucket to expand to' });
  /** `/selection/groups`: the right-click menu's groups. */
  groups: SelectionGroup[] = [];
  /** Every request, in order: the route and its JSON body. */
  readonly requests: { route: string; body: any }[] = [];

  /** Stub `fetch` with this server; `vi.unstubAllGlobals()` takes it down. */
  install(): this {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const route = String(url).split('?')[0];
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      this.requests.push({ route, body });
      return FakeSelectionServer.response(this.answer(route, body));
    }));
    return this;
  }

  /** The bodies of the requests to `route`, oldest first. */
  bodies(route: string): any[] {
    return this.requests.filter(r => r.route === route).map(r => r.body);
  }

  /** How many times `route` was asked. */
  count(route: string): number {
    return this.bodies(route).length;
  }

  private answer(route: string, body: any): Answer | undefined {
    switch (route) {
      case 'api/selection/expand-loop':
        return this.loop(body.entity);
      case 'api/selection/expand-bucket':
        return this.bucket(body.entity);
      case 'api/selection/groups':
        return { groups: this.groups };
      case 'api/apply-feature':
        return { success: true, preview: `${body.feature}(…)`, args: '…' };
      default:
        return undefined;
    }
  }

  /** What `fetch` resolves to: the fields the api functions read. */
  private static response(answer: Answer | undefined) {
    const failed = answer === undefined || (typeof answer === 'object' && answer !== null && 'error' in answer);
    const status = answer === undefined ? 404 : failed ? 422 : 200;
    return {
      ok: !failed,
      status,
      json: async () => answer ?? {},
      text: async () => JSON.stringify(answer ?? {}),
    };
  }
}
