import { motion } from 'framer-motion';
import { AgentSequenceGroup, type AgentSpec } from '@/components/AgentSequenceGroup';

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
  return (
    <>
      <section id="about" className="void-bg relative overflow-hidden">
        <div className="px-6 py-24">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-100px' }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="relative mx-auto max-w-2xl text-center"
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
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-60px' }}
          transition={{ duration: 0.5 }}
          className="mx-auto mt-20 max-w-xl text-center"
        >
          <h3 className="text-2xl text-white sm:text-4xl">Five agents, five real jobs</h3>
          <p className="mt-3 text-balance text-white/60">
            Not one giant prompt wearing five hats — five specialists, each owning one part of the
            pipeline, handing off to the next. Keep scrolling.
          </p>
        </motion.div>
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
