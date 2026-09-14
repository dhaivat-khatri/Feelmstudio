import { useEffect, useRef, useState } from 'react';

/**
 * Cubic remap that settles progress in the middle of its range instead of
 * moving at a constant rate — ported from the scroll-world skill's "linger"
 * technique (a scroll-scrubbed camera dwelling where the content actually
 * lands, instead of a flat fade-up). L=0 is linear; L=1 spends most of the
 * scroll range near x=0.5 and moves quickly through the edges.
 */
export function lingerEase(x: number, amount: number): number {
  const L = Math.min(Math.max(amount, 0), 1);
  const c = x - 0.5;
  return (1 - L) * x + L * (4 * c * c * c + 0.5);
}

/**
 * Continuous 0..1 scroll progress through a section: 0 when its top edge
 * enters the bottom of the viewport, 1 when its bottom edge leaves the top —
 * not a single whileInView trigger, so content can keep responding to scroll
 * the whole time the section is on screen. Manual rect math + a raw scroll
 * listener, same approach `ScrollSequence`/`AgentSequenceGroup` already use
 * on this page (framer's `useScroll({ target })` produced non-monotonic
 * values here).
 */
export function useSectionProgress<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let raf = 0;
    const update = () => {
      const rect = el.getBoundingClientRect();
      const span = rect.height + window.innerHeight;
      const p = span > 0 ? Math.min(Math.max((window.innerHeight - rect.top) / span, 0), 1) : 0;
      setProgress(p);
    };
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };

    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  return { ref, progress };
}
