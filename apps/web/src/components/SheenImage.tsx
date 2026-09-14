import type { CSSProperties } from 'react';

import { cn } from '@/lib/utils';

/**
 * The one deliberate "premium" move applied consistently across every
 * section-page illustration: a light sheen that sweeps across the panel as
 * you scroll past it — motion driven by scroll position, same spirit as the
 * scroll-world technique, without needing a generated video clip. `progress`
 * is the section's own 0..1 scroll progress (useSectionProgress), so the
 * sweep timing is already in sync with everything else on the page.
 */
export function SheenImage({
  src,
  progress,
  style,
  className,
}: {
  src: string;
  progress: number;
  style?: CSSProperties;
  className?: string;
}) {
  const sweepX = -40 + progress * 180;
  return (
    <div
      style={style}
      className={cn('relative overflow-hidden rounded-2xl border border-white/10 shadow-2xl', className)}
    >
      <img src={src} alt="" className="bg-media aspect-[3/2] size-full object-cover" />
      <div
        className="pointer-events-none absolute inset-[-20%] mix-blend-overlay"
        style={{
          background: 'linear-gradient(115deg, transparent 35%, rgba(255,255,255,0.22) 48%, transparent 60%)',
          transform: `translateX(${sweepX}%)`,
        }}
      />
    </div>
  );
}
