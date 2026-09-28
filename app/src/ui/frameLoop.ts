/**
 * One requestAnimationFrame loop for every animated element instead of one per
 * component. Callbacks of elements that are scrolled out of view are skipped
 * (IntersectionObserver), and all callbacks of a frame share one timestamp so
 * per-frame work (e.g. reading the audio clock) can be cached.
 */

type FrameCallback = (now: number) => void;

interface Entry {
  callback: FrameCallback;
  visible: boolean;
}

const entries = new Map<Element, Entry>();
let raf = 0;

const observer =
  typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver((changes) => {
        for (const change of changes) {
          const entry = entries.get(change.target);
          if (entry) entry.visible = change.isIntersecting;
        }
      })
    : null;

function tick(): void {
  raf = 0;
  const now = performance.now();
  for (const entry of entries.values()) if (entry.visible) entry.callback(now);
  if (entries.size > 0) raf = requestAnimationFrame(tick);
}

/** Calls `callback` every frame while `element` is on screen. Returns the unsubscribe function. */
export function onFrame(element: Element, callback: FrameCallback): () => void {
  entries.set(element, { callback, visible: true });
  observer?.observe(element);
  if (!raf) raf = requestAnimationFrame(tick);
  return () => {
    entries.delete(element);
    observer?.unobserve(element);
  };
}
