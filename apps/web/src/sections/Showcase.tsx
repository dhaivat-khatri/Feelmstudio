import { motion } from 'framer-motion';

const PANELS = [
  { file: '7767997c-c2ca-49cd-82ce-69e7d794e130.mp4', kind: 'video', label: 'Generated shot by shot, in the studio' },
  { file: '980aa46c-4537-4788-be8a-491ad2b7c6fa.png', kind: 'image', label: 'Every frame, straight out of the pipeline' },
  { file: 'c908cfa8-2ff5-46a6-bae3-a2fd7f69e306.mp4', kind: 'video', label: 'No stock footage, ever' },
] as const;

export function Showcase() {
  return (
    <section id="showcase" className="void-bg relative overflow-hidden px-6 py-24">
      <motion.h2
        initial={{ opacity: 0, y: 16 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-100px' }}
        transition={{ duration: 0.5, delay: 0.1 }}
        className="relative mb-14 text-center text-3xl text-white sm:text-5xl"
      >
        Straight out of the pipeline
      </motion.h2>

      <div className="relative mx-auto grid max-w-6xl gap-6 sm:grid-cols-3">
        {PANELS.map((p, i) => (
          <motion.div
            key={p.file}
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0, scale: 1 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.65, ease: [0.16, 1, 0.3, 1], delay: i * 0.1 }}
            className="glass-card overflow-hidden p-3"
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
          </motion.div>
        ))}
      </div>
    </section>
  );
}
