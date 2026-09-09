import { motion } from 'framer-motion';

export function Pricing() {
  return (
    <section id="pricing" className="void-bg relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-6 py-24 text-center">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-100px' }}
        transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
        className="relative max-w-xl"
      >
        <h2 className="text-3xl text-white sm:text-5xl">Free to try, right now.</h2>

        <p className="mt-6 text-balance text-white/65">
          Bring an idea and take it through the whole studio — Director to Editor, script to final
          cut — with no account and no setup. Generation runs on Google Cloud&rsquo;s Vertex AI.
        </p>

        <a
          href="/studio"
          className="mt-9 inline-flex items-center rounded-full bg-brand-1 px-7 py-3.5 text-sm font-semibold text-[#17100a] transition-colors hover:bg-brand-2"
        >
          Launch the studio
        </a>
      </motion.div>
    </section>
  );
}
