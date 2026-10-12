import iconPackages from '@tabler/icons/outline/packages.svg?raw';
import iconSearch from '@tabler/icons/outline/search.svg?raw';
import iconHeart from '@tabler/icons/outline/heart.svg?raw';
import iconDownload from '@tabler/icons/outline/download.svg?raw';
import iconExternalLink from '@tabler/icons/outline/external-link.svg?raw';
import iconArrowLeft from '@tabler/icons/outline/arrow-left.svg?raw';
import iconCloudOff from '@tabler/icons/outline/cloud-off.svg?raw';
import iconRefresh from '@tabler/icons/outline/refresh.svg?raw';
import iconUser from '@tabler/icons/outline/user.svg?raw';
import iconSortAscending from '@tabler/icons/outline/sort-ascending.svg?raw';
import iconSortDescending from '@tabler/icons/outline/sort-descending.svg?raw';
import iconBox from '@tabler/icons/outline/box.svg?raw';
import iconCube from '@tabler/icons/outline/cube.svg?raw';
import iconX from '@tabler/icons/outline/x.svg?raw';
import iconCheck from '@tabler/icons/outline/check.svg?raw';
import iconCircleCheck from '@tabler/icons/outline/circle-check.svg?raw';
import iconAlertTriangle from '@tabler/icons/outline/alert-triangle.svg?raw';
import iconCopy from '@tabler/icons/outline/copy.svg?raw';
import iconChevronDown from '@tabler/icons/outline/chevron-down.svg?raw';
import iconChevronLeft from '@tabler/icons/outline/chevron-left.svg?raw';
import iconChevronRight from '@tabler/icons/outline/chevron-right.svg?raw';

/**
 * The Hub panel's icons (Tabler, as the rest of the app), as markup the
 * panel's own code inserts; never anything from the hub.
 */
export class HubIcons {
  static readonly PACKAGES = iconPackages;
  static readonly SEARCH = iconSearch;
  static readonly HEART = iconHeart;
  static readonly DOWNLOAD = iconDownload;
  static readonly EXTERNAL = iconExternalLink;
  static readonly BACK = iconArrowLeft;
  static readonly OFFLINE = iconCloudOff;
  static readonly REFRESH = iconRefresh;
  static readonly USER = iconUser;
  static readonly SORT_ASC = iconSortAscending;
  static readonly SORT_DESC = iconSortDescending;
  static readonly BOX = iconBox;
  static readonly CUBE = iconCube;
  static readonly CLOSE = iconX;
  static readonly CHECK = iconCheck;
  static readonly DONE = iconCircleCheck;
  static readonly WARNING = iconAlertTriangle;
  static readonly COPY = iconCopy;
  static readonly CHEVRON_DOWN = iconChevronDown;
  static readonly CHEVRON_LEFT = iconChevronLeft;
  static readonly CHEVRON_RIGHT = iconChevronRight;

  /**
   * A span holding `svg`. `cls` sizes it, written out in full at each call
   * (`[&>svg]:size-3`) so the stylesheet's scanner sees the class.
   */
  static span(svg: string, cls = '[&>svg]:size-4'): HTMLSpanElement {
    const span = document.createElement('span');
    span.className = `inline-flex shrink-0 ${cls}`;
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = svg;
    return span;
  }
}

/**
 * An image from the engine's hub proxy. One that fails to load (a seeded
 * listing without bytes, the hub unreachable before it was cached) gives
 * way to `fallback`, or leaves, rather than showing a broken image.
 */
export class HubImage {
  static create(src: string, className: string, fallback?: () => HTMLElement): HTMLImageElement {
    const img = document.createElement('img');
    img.src = src;
    img.alt = '';
    img.loading = 'lazy';
    img.className = className;
    img.addEventListener('error', () => {
      if (fallback) {
        img.replaceWith(fallback());
      } else {
        img.remove();
      }
    }, { once: true });
    return img;
  }
}
