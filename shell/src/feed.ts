import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { fluidcadHome } from './engine/paths';

/**
 * The start-screen feed: tutorial links for the "Learn FluidCAD" panel and
 * dismissible notifications, served by the fluidcad-feed worker (the
 * FluidCAD-Feed repo). The worker already filters notifications by expiration
 * and by the app version we send it; this side adds a disk cache so the start
 * screen renders instantly and still shows something offline.
 */

export type FeedTutorial = {
  id: string;
  title: string;
  description: string;
  url: string;
  thumbnail: string;
};

export type FeedNotification = {
  id: string;
  /** HTML; the page sanitizes it down to formatting tags and http(s) links. */
  body: string;
  expiresAt: string | null;
  minVersion: string | null;
};

export type StartFeed = {
  tutorials: FeedTutorial[];
  notifications: FeedNotification[];
};

const FEED_URL = 'https://fluidcad-feed.cf-7ad.workers.dev';
const FETCH_TIMEOUT_MS = 8000;
const CACHE_MAX_AGE_MS = 15 * 60 * 1000;

type CachedFeed = { fetchedAt: string; appVersion: string; feed: StartFeed };

export class FeedService {
  /**
   * The feed to show right now: the cache when it is fresh, otherwise a fetch,
   * falling back to a stale cache (or an empty feed) when the network says no.
   * Expired notifications are re-filtered here because a cached copy may have
   * outlived them.
   */
  static async load(): Promise<StartFeed> {
    const cached = FeedService.readCache();
    if (cached && FeedService.isFresh(cached)) {
      return FeedService.withoutExpired(cached.feed);
    }
    try {
      const url = `${FeedService.baseUrl()}/feed?version=${encodeURIComponent(app.getVersion())}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) {
        throw new Error(`feed responded ${response.status}`);
      }
      const feed = FeedService.parseFeed(await response.json());
      FeedService.writeCache(feed);
      return FeedService.withoutExpired(feed);
    } catch {
      // Offline, or the worker is down — the start screen must not care.
      return FeedService.withoutExpired(cached?.feed ?? { tutorials: [], notifications: [] });
    }
  }

  private static baseUrl(): string {
    return process.env.FLUIDCAD_FEED_URL || FEED_URL;
  }

  private static cacheFile(): string {
    return path.join(fluidcadHome(), 'feed.json');
  }

  private static isFresh(cached: CachedFeed): boolean {
    const age = Date.now() - Date.parse(cached.fetchedAt);
    // A version change invalidates the cache: the worker filters by version.
    return cached.appVersion === app.getVersion() && Number.isFinite(age) && age >= 0 && age < CACHE_MAX_AGE_MS;
  }

  private static readCache(): CachedFeed | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(FeedService.cacheFile(), 'utf8'));
      if (typeof parsed?.fetchedAt === 'string' && typeof parsed?.appVersion === 'string') {
        return { fetchedAt: parsed.fetchedAt, appVersion: parsed.appVersion, feed: FeedService.parseFeed(parsed.feed) };
      }
    } catch {
      // No cache yet, or an unreadable one — same as having none.
    }
    return null;
  }

  private static writeCache(feed: StartFeed): void {
    try {
      fs.mkdirSync(fluidcadHome(), { recursive: true });
      const cached: CachedFeed = { fetchedAt: new Date().toISOString(), appVersion: app.getVersion(), feed };
      const file = FeedService.cacheFile();
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cached, null, 2) + '\n');
      fs.renameSync(tmp, file);
    } catch {
      // Losing the cache costs one refetch, nothing more.
    }
  }

  private static withoutExpired(feed: StartFeed): StartFeed {
    const now = Date.now();
    return {
      tutorials: feed.tutorials,
      notifications: feed.notifications.filter(
        (entry) => !entry.expiresAt || !(Date.parse(entry.expiresAt) <= now),
      ),
    };
  }

  /** Accept only what the page knows how to render; drop anything malformed. */
  private static parseFeed(raw: unknown): StartFeed {
    const source = (raw ?? {}) as { tutorials?: unknown; notifications?: unknown };
    const tutorials: FeedTutorial[] = [];
    for (const entry of Array.isArray(source.tutorials) ? source.tutorials : []) {
      const tutorial = FeedService.parseTutorial(entry);
      if (tutorial) {
        tutorials.push(tutorial);
      }
    }
    const notifications: FeedNotification[] = [];
    for (const entry of Array.isArray(source.notifications) ? source.notifications : []) {
      const notification = FeedService.parseNotification(entry);
      if (notification) {
        notifications.push(notification);
      }
    }
    return { tutorials, notifications };
  }

  private static parseTutorial(raw: unknown): FeedTutorial | null {
    const entry = raw as Partial<FeedTutorial> | null;
    if (!entry || typeof entry.id !== 'string' || typeof entry.title !== 'string' || !FeedService.isHttpUrl(entry.url)) {
      return null;
    }
    return {
      id: entry.id,
      title: entry.title,
      description: typeof entry.description === 'string' ? entry.description : '',
      url: entry.url as string,
      thumbnail: FeedService.isHttpUrl(entry.thumbnail) ? (entry.thumbnail as string) : '',
    };
  }

  private static parseNotification(raw: unknown): FeedNotification | null {
    const entry = raw as Partial<FeedNotification> | null;
    if (!entry || typeof entry.id !== 'string' || typeof entry.body !== 'string') {
      return null;
    }
    return {
      id: entry.id,
      body: entry.body,
      expiresAt: typeof entry.expiresAt === 'string' ? entry.expiresAt : null,
      minVersion: typeof entry.minVersion === 'string' ? entry.minVersion : null,
    };
  }

  private static isHttpUrl(value: unknown): value is string {
    return typeof value === 'string' && /^https?:\/\//.test(value);
  }
}
