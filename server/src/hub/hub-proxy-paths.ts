/**
 * The engine's proxy paths for the hub's images (hub-plan H10, HD15: the UI
 * never calls the hub). The hub answers absolute URLs for a feature's icon
 * (`<hub>/api/v1/packages/@s/n/versions/v/files/<path>`) and a package's
 * screenshots (`<hub>/api/v1/packages/@s/n/media/<id>`); the bridge hands
 * the UI its own paths for them instead, relative like every other engine
 * URL the UI uses:
 * - `api/hub/files/@s/n/v/<path>`;
 * - `api/hub/media/@s/n/<id>`.
 *
 * A URL that is neither, or names another origin, becomes null: the UI
 * never loads a third-party image.
 */
export class HubProxyPaths {
  static readonly FILES = 'api/hub/files';
  static readonly MEDIA = 'api/hub/media';

  private static readonly FILE_ROUTE = /^\/api\/v1\/packages\/(@[^/]+)\/([^/]+)\/versions\/([^/]+)\/files\/(.+)$/;
  private static readonly MEDIA_ROUTE = /^\/api\/v1\/packages\/(@[^/]+)\/([^/]+)\/media\/([^/]+)$/;

  /** The proxy path for a hub `url` from `origin`, or null when it isn't a file or screenshot of that hub. */
  static rewrite(url: string | null | undefined, origin: string): string | null {
    if (!url) {
      return null;
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.origin !== origin || parsed.search || parsed.hash) {
      return null;
    }
    const path = parsed.pathname.replace(/^\/api\/v1\/packages\/%40/i, '/api/v1/packages/@');
    const file = HubProxyPaths.FILE_ROUTE.exec(path);
    if (file) {
      const [, scope, name, version, rest] = file;
      return `${HubProxyPaths.FILES}/${scope}/${name}/${version}/${rest}`;
    }
    const media = HubProxyPaths.MEDIA_ROUTE.exec(path);
    if (media) {
      const [, scope, name, id] = media;
      return `${HubProxyPaths.MEDIA}/${scope}/${name}/${id}`;
    }
    return null;
  }
}
