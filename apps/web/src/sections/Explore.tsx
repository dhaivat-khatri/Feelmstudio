import { lingerEase, useSectionProgress } from '@/lib/scroll-progress';

const CARDS = [
  {
    href: '/about',
    image: '/landing/about.webp',
    title: 'About',
    body: 'Why a real dependency graph beats one giant prompt.',
  },
  {
    href: '/services',
    image: '/landing/services.webp',
    title: 'Services',
    body: 'Five specialists, each doing one real job, handing it to the next.',
  },
  {
    href: '/portfolio',
    image: '/media/980aa46c-4537-4788-be8a-491ad2b7c6fa.png',
    title: 'Portfolio',
    body: "What the pipeline's actually produced so far.",
  },
  {
    href: '/pricing',
    image: '/landing/pricing.webp',
    title: 'Pricing',
    body: 'Free to try, right now — no account, no setup.',
  },
  {
    href: '/contact',
    image: '/landing/contact.webp',
    title: 'Contact',
    body: 'Questions, feedback, ideas — we read every one.',
  },
] as const;

/**
 * The home page's hero scrub ends and used to drop straight into the
 * Footer — the world it opens (crew, pipeline, pricing) was never actually
 * reachable from here. This closes that gap: the same continuous
 * linger-paced reveal as every other section, surfacing where the site
 * actually goes next instead of ending the journey.
 */
export function Explore() {
  const { ref, progress } = useSectionProgress<HTMLElement>();
  const settle = lingerEase(progress, 0.55);
  const fadeIn = Math.min(Math.max(progress / 0.15, 0), 1);
  const fadeOut = Math.min(Math.max((1 - progress) / 0.2, 0), 1);
  const opacity = Math.min(fadeIn, fadeOut);
  const headingY = (0.5 - settle) * 50;
  // Drifts the card art opposite the scroll direction — a slower plane behind
  // the cards' own settle-in, so the section reads as depth rather than a
  // flat fade, without touching the hero's frame-scrub technique.
  const parallaxY = (0.5 - progress) * 28;

  return (
    <section ref={ref} className="void-bg relative overflow-hidden px-6 py-28">
      <h2
        style={{ opacity, transform: `translateY(${headingY}px)` }}
        className="hero-display relative mx-auto max-w-4xl text-balance text-center uppercase leading-[0.92] text-white transition-[opacity,transform] duration-100 ease-out text-[clamp(2.4rem,7vw,5.5rem)]"
      >
        The rest of the world
      </h2>
      <p
        style={{ opacity, transform: `translateY(${headingY}px)` }}
        className="relative mx-auto mt-5 max-w-md text-balance text-center text-white/60 transition-[opacity,transform] duration-100 ease-out"
      >
        The crew, the pipeline, the price, and how to reach us.
      </p>

      <div className="relative mx-auto mt-16 grid max-w-6xl gap-5 sm:grid-cols-2 lg:grid-cols-5">
        {CARDS.map((c, i) => {
          const cardSettle = lingerEase(Math.min(Math.max((progress - 0.1 - i * 0.04) / 0.55, 0), 1), 0.3);
          const tilt = (1 - cardSettle) * (i % 2 === 0 ? -4 : 4);
          const scale = 0.92 + cardSettle * 0.08;
          return (
            <a
              key={c.href}
              href={c.href}
              style={{
                opacity: opacity * cardSettle,
                transform: `translateY(${(1 - cardSettle) * 26}px) scale(${scale}) rotate(${tilt}deg)`,
              }}
              className="group glass-card overflow-hidden transition-[opacity,transform] duration-150 ease-out"
            >
              <div className="aspect-[4/3] overflow-hidden">
                <div style={{ transform: `translateY(${parallaxY}px)` }} className="size-full">
                  <img
                    src={c.image}
                    alt=""
                    className="size-full scale-110 object-cover transition-transform duration-500 group-hover:scale-125"
                  />
                </div>
              </div>
              <div className="p-4">
                <p className="font-heading text-lg text-white">{c.title}</p>
                <p className="mt-1 text-xs text-balance text-white/55">{c.body}</p>
              </div>
            </a>
          );
        })}
      </div>
    </section>
  );
}
