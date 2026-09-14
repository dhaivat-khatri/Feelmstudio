import { lingerEase, useSectionProgress } from '@/lib/scroll-progress';

const PANELS = [
  { file: '7767997c-c2ca-49cd-82ce-69e7d794e130.mp4', kind: 'video', label: 'Generated shot by shot, in the studio' },
  { file: '980aa46c-4537-4788-be8a-491ad2b7c6fa.png', kind: 'image', label: 'Every frame, straight out of the pipeline' },
  { file: 'c908cfa8-2ff5-46a6-bae3-a2fd7f69e306.mp4', kind: 'video', label: 'No stock footage, ever' },
] as const;

/** Same continuous scroll-pacing treatment as `Services.tsx` — see its comment. */
export function Showcase() {
  const { ref, progress } = useSectionProgress<HTMLElement>();
  const settle = lingerEase(progress, 0.6);

  const fadeIn = Math.min(Math.max(progress / 0.18, 0), 1);
  const fadeOut = Math.min(Math.max((1 - progress) / 0.18, 0), 1);
  const opacity = Math.min(fadeIn, fadeOut);
  const y = (0.5 - settle) * 70;
  const glowY = (progress - 0.5) * -60;

  return (
    <section ref={ref} id="showcase" className="void-bg relative overflow-hidden px-6 py-24">
      <div
        className="pointer-events-none absolute inset-x-0 top-1/3 h-[60vh] opacity-40"
        style={{
          transform: `translateY(${glowY}px)`,
          background: 'radial-gradient(ellipse 60% 50% at 50% 50%, color-mix(in oklch, var(--brand-1), transparent 88%), transparent 70%)',
        }}
      />

      <h2
        style={{ opacity, transform: `translateY(${y}px)` }}
        className="relative mb-14 text-center text-3xl text-white transition-[opacity,transform] duration-100 ease-out sm:text-5xl"
      >
        Straight out of the pipeline
      </h2>

      <div className="relative mx-auto grid max-w-6xl gap-6 sm:grid-cols-3">
        {PANELS.map((p, i) => {
          const panelSettle = lingerEase(Math.min(Math.max((progress - i * 0.05) / 0.5, 0), 1), 0.35);
          return (
            <div
              key={p.file}
              style={{
                opacity: opacity * panelSettle,
                transform: `translateY(${(1 - panelSettle) * 28}px)`,
              }}
              className="glass-card overflow-hidden p-3 transition-[opacity,transform] duration-150 ease-out"
            >
              <div className="aspect-[4/5] overflow-hidden rounded-[16px]">
                {p.kind === 'video' ? (
                  <video
                    src={`/media/${p.file}`}
                    className="bg-media size-full object-cover"
                    autoPlay
                    loop
                    muted
                    playsInline
                  />
                ) : (
                  <img src={`/media/${p.file}`} alt="" className="bg-media size-full object-cover" />
                )}
              </div>
              <p className="mt-3 px-1 text-sm font-medium text-white/80">{p.label}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
