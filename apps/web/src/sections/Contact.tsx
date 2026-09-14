import { SheenImage } from '@/components/SheenImage';
import { lingerEase, useSectionProgress } from '@/lib/scroll-progress';

/** Same continuous scroll-pacing treatment as `Services.tsx` — see its comment. */
export function Contact() {
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
      id="contact"
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
        <div style={{ opacity, transform: `translateY(${y}px)` }} className="text-center transition-[opacity,transform] duration-100 ease-out lg:order-2 lg:text-left">
          <h2 className="text-3xl text-white sm:text-5xl">Questions, feedback, ideas?</h2>

          <a
            href="mailto:dhaivatkhatri28@gmail.com"
            className="mt-9 inline-flex items-center rounded-full bg-brand-1 px-7 py-3.5 text-sm font-semibold text-[#17100a] transition-colors hover:bg-brand-2"
          >
            Email us
          </a>
        </div>

        <SheenImage
          src="/landing/contact.webp"
          progress={progress}
          style={{ opacity, transform: `translateY(${y * 0.6}px) scale(${0.97 + settle * 0.03})` }}
          className="transition-[opacity,transform] duration-100 ease-out lg:order-1"
        />
      </div>
    </section>
  );
}
