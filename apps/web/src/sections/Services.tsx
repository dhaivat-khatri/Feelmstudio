import { SheenImage } from '@/components/SheenImage';
import { lingerEase, useSectionProgress } from '@/lib/scroll-progress';

const CREW = ['Director', 'Writer', 'Cinematographer', 'Editor', 'Composer'];

/**
 * Borrows the scroll-world skill's "linger" pacing: instead of a single
 * whileInView snap, the heading and each crew pill track continuous scroll
 * progress through the section, settling (via `lingerEase`) right around
 * where the section centers in the viewport, with a slow parallax glow
 * behind it — the same "camera dwells where the content lands" feel as the
 * skill's scroll-scrubbed camera, without needing any generated video.
 */
export function Services() {
  const { ref, progress } = useSectionProgress<HTMLElement>();
  const settle = lingerEase(progress, 0.6);

  const fadeIn = Math.min(Math.max(progress / 0.18, 0), 1);
  const fadeOut = Math.min(Math.max((1 - progress) / 0.18, 0), 1);
  const opacity = Math.min(fadeIn, fadeOut);
  const y = (0.5 - settle) * 70;
  const glowY = (progress - 0.5) * -60;

  return (
    <section
      ref={ref}
      id="services"
      className="void-bg relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-6 py-24 text-center"
    >
      <div
        className="pointer-events-none absolute inset-x-0 top-1/2 h-[60vh] -translate-y-1/2 opacity-40"
        style={{
          transform: `translateY(calc(-50% + ${glowY}px))`,
          background: 'radial-gradient(ellipse 60% 50% at 50% 50%, color-mix(in oklch, var(--brand-1), transparent 88%), transparent 70%)',
        }}
      />

      <div className="relative mx-auto grid max-w-6xl items-center gap-10 lg:grid-cols-2">
        <SheenImage
          src="/landing/services.webp"
          progress={progress}
          style={{ opacity, transform: `translateY(${y * 0.6}px) scale(${0.97 + settle * 0.03})` }}
          className="transition-[opacity,transform] duration-100 ease-out"
        />

        <div className="text-center lg:text-left">
          <h2
            style={{ opacity, transform: `translateY(${y}px)` }}
            className="max-w-xl text-3xl text-white transition-[opacity,transform] duration-100 ease-out sm:text-5xl"
          >
            A real crew, not one giant prompt
          </h2>

          <div className="mt-10 flex flex-wrap items-center justify-center gap-3 lg:justify-start">
            {CREW.map((role, i) => {
              const chipSettle = lingerEase(Math.min(Math.max((progress - i * 0.03) / 0.5, 0), 1), 0.3);
              return (
                <span
                  key={role}
                  style={{
                    opacity: opacity * chipSettle,
                    transform: `translateY(${(1 - chipSettle) * 16}px) scale(${0.85 + chipSettle * 0.15})`,
                  }}
                  className="glass-card px-5 py-2.5 text-sm font-medium text-white transition-[opacity,transform] duration-150 ease-out"
                >
                  {role}
                </span>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
