import { useEffect, useRef } from 'react';
import { animate, stagger, type JSAnimation } from 'animejs';
import { prefersReducedMotion } from '@/lib/motion-prefs';

interface StaggerTextProps {
  children: string;
  as?: 'span' | 'p';
  className?: string;
  /** 'mount' plays immediately (nav wordmark); 'inView' waits for scroll (default). */
  trigger?: 'mount' | 'inView';
  delay?: number;
}

/**
 * Letter-by-letter reveal, the one thing anime.js's staggered multi-target
 * timelines do more cleanly than a framer-motion variant fan-out. Used
 * sparingly on wordmarks and section eyebrows — never headings or body copy.
 * The full string stays in the DOM as a screen-reader-visible label at all
 * times; only the decorative per-letter spans are hidden from assistive tech.
 */
export function StaggerText({ children, as = 'span', className, trigger = 'inView', delay = 0 }: StaggerTextProps) {
  const Tag = as;
  const ref = useRef<HTMLElement>(null);
  const setRef = (node: HTMLElement | null) => {
    ref.current = node;
  };
  const played = useRef(false);
  const anim = useRef<JSAnimation | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const letters = el.querySelectorAll<HTMLElement>('[data-letter]');
    if (letters.length === 0) return;

    const play = () => {
      if (played.current) return;
      played.current = true;
      if (prefersReducedMotion()) {
        anim.current = animate(letters, { opacity: [0, 1], duration: 250, delay });
        return;
      }
      anim.current = animate(letters, {
        opacity: [0, 1],
        translateY: [10, 0],
        duration: 550,
        delay: stagger(22, { start: delay }),
        ease: 'outExpo',
      });
    };

    if (trigger === 'mount') {
      play();
      return () => {
        anim.current?.pause();
      };
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) play();
      },
      { rootMargin: '-10% 0px -10% 0px', threshold: 0.4 },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      anim.current?.pause();
    };
  }, [delay, trigger]);

  return (
    <Tag ref={setRef} className={className} aria-label={children}>
      {children.split('').map((ch, i) => (
        <span key={i} data-letter aria-hidden="true" className="inline-block" style={{ opacity: 0 }}>
          {ch === ' ' ? ' ' : ch}
        </span>
      ))}
    </Tag>
  );
}
