import { motion } from 'framer-motion';

const CREW = ['Director', 'Writer', 'Cinematographer', 'Editor', 'Composer'];

export function Services() {
  return (
    <section id="services" className="void-bg relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-6 py-24 text-center">
      <motion.h2
        initial={{ opacity: 0, y: 16 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-100px' }}
        transition={{ duration: 0.5, delay: 0.1 }}
        className="relative max-w-3xl text-3xl text-white sm:text-5xl"
      >
        A real crew, not one giant prompt
      </motion.h2>

      <div className="relative mt-10 flex flex-wrap items-center justify-center gap-3">
        {CREW.map((role, i) => (
          <motion.span
            key={role}
            initial={{ opacity: 0, y: 20, scale: 0.8 }}
            whileInView={{ opacity: 1, y: 0, scale: 1 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1], delay: i * 0.08 }}
            className="glass-card px-5 py-2.5 text-sm font-medium text-white"
          >
            {role}
          </motion.span>
        ))}
      </div>
    </section>
  );
}
