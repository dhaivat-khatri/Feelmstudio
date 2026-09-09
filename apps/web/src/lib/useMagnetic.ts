import { useEffect, useRef } from 'react';
import { animate, type JSAnimation } from 'animejs';
import { hasFinePointer, prefersReducedMotion } from '@/lib/motion-prefs';

/**
 * Magnetic-hover CTA pull: the button leans toward the cursor within its own
 * bounds, then eases back on release. This is the anime.js case framer's
 * declarative `whileHover={{ scale }}` can't express well (continuous
 * pointer-position tracking, not a two-state transition) — desktop-only
 * (`pointer: fine`), no-op under `prefers-reduced-motion`, and skips touch
 * devices entirely so it never fights tap targets on mobile.
 */
export function useMagnetic<T extends HTMLElement>(strength = 0.3) {
  const ref = useRef<T>(null);
  const anim = useRef<JSAnimation | null>(null);

  // Full-page navigation (no client router here) tears this down anyway, but
  // a lingering release-ease animation should still stop writing to the node
  // the moment React unmounts it, not 650ms later.
  useEffect(() => {
    return () => {
      anim.current?.pause();
    };
  }, []);

  const onPointerMove = (e: React.PointerEvent<T>) => {
    const el = ref.current;
    if (!el || !hasFinePointer() || prefersReducedMotion()) return;
    const rect = el.getBoundingClientRect();
    const x = (e.clientX - rect.left - rect.width / 2) * strength;
    const y = (e.clientY - rect.top - rect.height / 2) * strength;
    anim.current = animate(el, { translateX: x, translateY: y, scale: 1.06, duration: 450, ease: 'out(3)' });
  };

  const onPointerLeave = () => {
    const el = ref.current;
    if (!el) return;
    anim.current = animate(el, { translateX: 0, translateY: 0, scale: 1, duration: 650, ease: 'outElastic(1, .7)' });
  };

  const onPointerDown = () => {
    const el = ref.current;
    if (!el || !hasFinePointer() || prefersReducedMotion()) return;
    anim.current = animate(el, { scale: 0.94, duration: 150, ease: 'outQuad' });
  };

  const onPointerUp = () => {
    const el = ref.current;
    if (!el || !hasFinePointer() || prefersReducedMotion()) return;
    anim.current = animate(el, { scale: 1.06, duration: 200, ease: 'outBack(1.5)' });
  };

  return { ref, onPointerMove, onPointerLeave, onPointerDown, onPointerUp };
}
