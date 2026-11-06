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
 * A deployed hub hands a screenshot out on its public media origin instead
 * (`https://media.fluidcad.io/media/@s/n/<id>.png`, straight from its
 * bucket). That URL is read for the package and the id only and goes on the
 * same `api/hub/media` path, which fetches the screenshot from the hub's own
 * API route: the media origin is never contacted, whatever it names.
 *
 * Any other URL, or one of those two routes on another origin, becomes null:
 * the UI never loads a third-party image.
 */
export class HubProxyPaths {
  static readonly FILES = 'api/hub/files';
  static readonly MEDIA = 'api/hub/media';

  private static readonly FILE_ROUTE = /^\/api\/v1\/packages\/(@[^/]+)\/([^/]+)\/versions\/([^/]+)\/files\/(.+)$/;
  private static readonly MEDIA_ROUTE = /^\/api\/v1\/packages\/(@[^/]+)\/([^/]+)\/media\/([^/]+)$/;
  /** A screenshot on the hub's media origin: `/media/@s/n/<id>.<ext>`. */
  private static readonly MEDIA_ORIGIN_ROUTE = /^\/media\/(@[^/]+)\/([^/]+)\/([A-Za-z0-9-]{1,64})\.[A-Za-z0-9]{1,8}$/;

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
    if (parsed.search || parsed.hash) {
      return null;
    }
    if (parsed.origin !== origin) {
      const shot = parsed.protocol === 'https:'
        ? HubProxyPaths.MEDIA_ORIGIN_ROUTE.exec(parsed.pathname.replace(/^\/media\/%40/i, '/media/@'))
        : null;
      return shot ? `${HubProxyPaths.MEDIA}/${shot[1]}/${shot[2]}/${shot[3]}` : null;
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
