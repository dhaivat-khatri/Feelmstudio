import { AgentSequenceGroup, type AgentSpec } from '@/components/AgentSequenceGroup';
import { SheenImage } from '@/components/SheenImage';
import { lingerEase, useSectionProgress } from '@/lib/scroll-progress';

const CREW: readonly AgentSpec[] = [
  {
    slug: 'director',
    role: 'Director',
    description:
      "Sets the creative brief from a one-line idea — tone, palette, pacing, mood, genre. Every other agent reads from it, and it stays editable the whole way through production.",
  },
  {
    slug: 'writer',
    role: 'Writer',
    description:
      'Drafts the full script scene by scene from the brief, and owns every re-segmentation after — split a scene, merge two, rewrite one, review the diff before it lands.',
  },
  {
    slug: 'cinematographer',
    role: 'Cinematographer',
    description:
      'Decides shot type, framing, and camera move for every scene — plans the whole sequence in one pass, or re-plans a single scene as the script evolves.',
  },
  {
    slug: 'composer',
    role: 'Composer',
    description:
      "Reads the brief and decides the score's direction — genre, instrumentation, tempo, mood — so the music matches the story before a single note is generated.",
  },
  {
    slug: 'editor',
    role: 'Editor',
    description:
      'The final review checkpoint. Approves the cut, reorders or trims scenes out of the assembled sequence, and flags anything that still needs attention.',
  },
];

export function About() {
  const { ref, progress } = useSectionProgress<HTMLElement>();
  const settle = lingerEase(progress, 0.6);
  const fadeIn = Math.min(Math.max(progress / 0.18, 0), 1);
  const fadeOut = Math.min(Math.max((1 - progress) / 0.18, 0), 1);
  const opacity = Math.min(fadeIn, fadeOut);
  const y = (0.5 - settle) * 70;
  const subSettle = lingerEase(Math.min(Math.max((progress - 0.08) / 0.5, 0), 1), 0.4);

  return (
    <>
      <section ref={ref} id="about" className="void-bg relative overflow-hidden">
        <div className="mx-auto max-w-6xl px-6 py-24">
        <div className="grid items-center gap-10 lg:grid-cols-2">
          <div
            style={{ opacity, transform: `translateY(${y}px)` }}
            className="relative text-center transition-[opacity,transform] duration-100 ease-out lg:order-2 lg:text-left"
          >
            <h2 className="text-3xl text-white sm:text-5xl">
              Built for the trust problem every AI video tool skips
            </h2>

            <p className="mt-6 text-balance text-white/70">
              Every scene, image, video, and script line is a node in a real dependency graph — change
              the style brief and only the scenes that used it get flagged. Generated media is never
              silently overwritten; regenerating is always your explicit call. Split a scene, merge two,
              rewrite one from scratch — identity survives the edit instead of quietly renumbering your
              work out from under you.
            </p>
          </div>

          <SheenImage
            src="/landing/about.webp"
            progress={progress}
            style={{ opacity, transform: `translateY(${y * 0.6}px) scale(${0.97 + settle * 0.03})` }}
            className="transition-[opacity,transform] duration-100 ease-out lg:order-1"
          />
        </div>

        <div
          style={{ opacity: opacity * subSettle, transform: `translateY(${(1 - subSettle) * 24}px)` }}
          className="mx-auto mt-20 max-w-xl text-center transition-[opacity,transform] duration-100 ease-out"
        >
          <h3 className="text-2xl text-white sm:text-4xl">Five agents, five real jobs</h3>
          <p className="mt-3 text-balance text-white/60">
            Not one giant prompt wearing five hats — five specialists, each owning one part of the
            pipeline, handing off to the next. Keep scrolling.
          </p>
        </div>
        </div>
      </section>

      {/* Deliberately a sibling of #about, not nested inside it — that section's
          `overflow-hidden` broke `position: sticky` for any descendant (a well-
          known CSS interaction: sticky positioning requires every ancestor up to
          the intended scroll container to have `overflow: visible`). Confirmed by
          reading the sticky element's own `getBoundingClientRect().top` while
          scrolling: it never stopped at 0, it just decreased continuously like a
          normal in-flow element — it was never actually pinning, at all. */}
      <AgentSequenceGroup agents={CREW} />
    </>
  );
}
