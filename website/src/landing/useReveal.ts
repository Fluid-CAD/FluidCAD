import {useEffect, useRef, useState} from 'react';

/**
 * Fires once, the first time the element comes into view.
 *
 * The contract that matters: **the element is visible before this ever
 * returns true.** Nothing on the page is hidden waiting for an observer, so
 * a print stylesheet, a headless renderer, a background tab or a browser with
 * scripting off all show a finished page. The flag only decides whether an
 * entrance *runs*, never whether the content exists.
 */
export function useReveal<T extends HTMLElement>(rootMargin = '-12% 0px') {
  const ref = useRef<T>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || shown) {
      return undefined;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          setShown(true);
        }
      },
      {rootMargin},
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [rootMargin, shown]);

  return [ref, shown] as const;
}
