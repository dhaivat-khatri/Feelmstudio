import { motion } from 'framer-motion';

export function Contact() {
  return (
    <section id="contact" className="void-bg relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-6 py-24 text-center">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-100px' }}
        transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
        className="relative max-w-xl"
      >
        <h2 className="text-3xl text-white sm:text-5xl">Questions, feedback, ideas?</h2>

        <a
          href="mailto:dhaivatkhatri28@gmail.com"
          className="mt-9 inline-flex items-center rounded-full bg-brand-1 px-7 py-3.5 text-sm font-semibold text-[#17100a] transition-colors hover:bg-brand-2"
        >
          Email us
        </a>
      </motion.div>
    </section>
  );
}
