import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { fluidcadHome } from './engine/paths';

/**
 * The start-screen feed: tutorial links for the "Learn FluidCAD" panel and
 * dismissible notifications. The whole feed is one static `feed.json` in a
 * public R2 bucket (edited locally from the FluidCAD-Feed repo), so all the
 * filtering — expiration, a notification's minimum app version — happens
 * here, plus a disk cache so the start screen renders instantly and still
 * shows something offline.
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

const FEED_URL = 'https://pub-65a51652a62f42f092a714cd9f7a3020.r2.dev/feed.json';
const FETCH_TIMEOUT_MS = 8000;
const CACHE_MAX_AGE_MS = 15 * 60 * 1000;

type CachedFeed = { fetchedAt: string; feed: StartFeed };

export class FeedService {
  /**
   * The feed to show right now: the cache when it is fresh, otherwise a fetch,
   * falling back to a stale cache (or an empty feed) when the network says no.
   * Filtering always runs on the way out — the file is the same for everyone,
   * and a cached copy may have outlived an expiration date.
   */
  static async load(): Promise<StartFeed> {
    const cached = FeedService.readCache();
    if (cached && FeedService.isFresh(cached)) {
      return FeedService.visible(cached.feed);
    }
    try {
      const url = process.env.FLUIDCAD_FEED_URL || FEED_URL;
      const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) {
        throw new Error(`feed responded ${response.status}`);
      }
      const feed = FeedService.parseFeed(await response.json());
      FeedService.writeCache(feed);
      return FeedService.visible(feed);
    } catch {
      // Offline, or the bucket is unreachable — the start screen must not care.
      return FeedService.visible(cached?.feed ?? { tutorials: [], notifications: [] });
    }
  }

  private static cacheFile(): string {
    return path.join(fluidcadHome(), 'feed.json');
  }

  private static isFresh(cached: CachedFeed): boolean {
    const age = Date.now() - Date.parse(cached.fetchedAt);
    return Number.isFinite(age) && age >= 0 && age < CACHE_MAX_AGE_MS;
  }

  private static readCache(): CachedFeed | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(FeedService.cacheFile(), 'utf8'));
      if (typeof parsed?.fetchedAt === 'string') {
        return { fetchedAt: parsed.fetchedAt, feed: FeedService.parseFeed(parsed.feed) };
      }
    } catch {
      // No cache yet, or an unreadable one — same as having none.
    }
    return null;
  }

  private static writeCache(feed: StartFeed): void {
    try {
      fs.mkdirSync(fluidcadHome(), { recursive: true });
      const cached: CachedFeed = { fetchedAt: new Date().toISOString(), feed };
      const file = FeedService.cacheFile();
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cached, null, 2) + '\n');
      fs.renameSync(tmp, file);
    } catch {
      // Losing the cache costs one refetch, nothing more.
    }
  }

  /** What this app version shows: not expired, and not gated to a newer app. */
  private static visible(feed: StartFeed): StartFeed {
    const now = Date.now();
    const version = app.getVersion();
    return {
      tutorials: feed.tutorials,
      notifications: feed.notifications.filter((entry) => {
        if (entry.expiresAt && Date.parse(entry.expiresAt) <= now) {
          return false;
        }
        if (entry.minVersion && FeedService.compareVersions(version, entry.minVersion) < 0) {
          return false;
        }
        return true;
      }),
    };
  }

  /** Numeric dotted compare: negative when a < b, 0 when equal, positive when a > b. */
  private static compareVersions(a: string, b: string): number {
    const left = a.split('.').map((part) => parseInt(part, 10) || 0);
    const right = b.split('.').map((part) => parseInt(part, 10) || 0);
    const length = Math.max(left.length, right.length);
    for (let i = 0; i < length; i++) {
      const diff = (left[i] ?? 0) - (right[i] ?? 0);
      if (diff !== 0) {
        return diff;
      }
    }
    return 0;
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
