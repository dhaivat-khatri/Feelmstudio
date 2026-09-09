import { useRef } from 'react';
import { motion, useMotionValue, useTransform } from 'framer-motion';
import { Bell, Clapperboard, LayoutDashboard } from 'lucide-react';

import { BrandMark } from '@/components/BrandMark';

function useTilt() {
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const rotateX = useTransform(y, [-0.5, 0.5], [8, -8]);
  const rotateY = useTransform(x, [-0.5, 0.5], [-8, 8]);

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    x.set((e.clientX - rect.left) / rect.width - 0.5);
    y.set((e.clientY - rect.top) / rect.height - 0.5);
  };
  const onPointerLeave = () => {
    x.set(0);
    y.set(0);
  };

  return { rotateX, rotateY, onPointerMove, onPointerLeave };
}

const BARS = [40, 70, 55, 90, 65];

function DashboardCard() {
  return (
    <motion.div
      initial={{ opacity: 0, x: -60, y: -20, scale: 0.8 }}
      animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
      transition={{ type: 'spring', bounce: 0.55, duration: 1, delay: 0.6 }}
      className="glass-card absolute -left-4 top-4 hidden w-44 flex-col gap-2 p-4 sm:-left-16 sm:flex md:-left-28"
    >
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-white/70">
        <LayoutDashboard className="size-3.5 text-brand-1" /> Scenes
      </div>
      <div className="flex gap-1.5">
        {BARS.map((h, i) => (
          <motion.div
            key={i}
            initial={{ height: 0 }}
            animate={{ height: `${h}%` }}
            transition={{ duration: 0.8, delay: 1.1 + i * 0.08, ease: 'easeOut' }}
            style={{ height: `${h}%` }}
            className="w-3 rounded-full bg-gradient-to-t from-brand-1 to-brand-2"
          />
        ))}
      </div>
    </motion.div>
  );
}

function NavChip() {
  return (
    <motion.div
      initial={{ opacity: 0, x: 60, y: -30, scale: 0.8 }}
      animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
      transition={{ type: 'spring', bounce: 0.55, duration: 1, delay: 0.75 }}
      className="glass-card absolute -right-2 top-8 hidden items-center gap-2 px-4 py-2 text-xs font-medium text-white sm:-right-12 sm:flex md:-right-24"
    >
      <Clapperboard className="size-3.5 text-brand-2" /> Director
    </motion.div>
  );
}

function NotificationBubble() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 60, scale: 0.6 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: 'spring', bounce: 0.6, duration: 0.9, delay: 1 }}
      className="glass-card glow-brand absolute -bottom-2 right-0 hidden items-center gap-2 px-4 py-2.5 text-xs font-medium text-white sm:-bottom-6 sm:right-4 sm:flex md:right-16"
    >
      <Bell className="size-3.5 text-brand-1" /> Scene ready
    </motion.div>
  );
}

export function Hero() {
  const { rotateX, rotateY, onPointerMove, onPointerLeave } = useTilt();
  const containerRef = useRef<HTMLDivElement>(null);

  return (
    <section className="void-bg relative flex h-screen flex-col items-center justify-center overflow-hidden px-6 text-center">
      <video
        src="/bg/blackhole.mp4"
        className="absolute inset-0 size-full object-cover opacity-30 blur-md"
        autoPlay
        loop
        muted
        playsInline
      />

      <motion.div
        ref={containerRef}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        style={{ rotateX, rotateY, transformPerspective: 800 }}
        className="relative flex flex-col items-center"
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.5 }}
          animate={{ opacity: 1, scale: 1, y: [0, -8, 0] }}
          transition={{
            opacity: { duration: 0.5, type: 'spring', bounce: 0.6 },
            scale: { duration: 0.5, type: 'spring', bounce: 0.6 },
            y: { duration: 3, repeat: Infinity, ease: 'easeInOut', delay: 0.8 },
          }}
          className="glow-brand relative flex size-20 items-center justify-center rounded-3xl bg-gradient-to-br from-brand-1 to-brand-2 sm:size-24"
        >
          <BrandMark size={46} className="text-[#1c1206] sm:hidden" />
          <BrandMark size={54} className="hidden text-[#1c1206] sm:block" />
        </motion.div>

        <DashboardCard />
        <NavChip />
        <NotificationBubble />

        <motion.h1
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.3 }}
          className="relative mt-8 max-w-3xl text-balance text-4xl font-medium text-white sm:text-6xl"
        >
          Idea to published film
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.45 }}
          className="relative mt-5 max-w-lg text-balance text-white/70"
        >
          A production studio run by real AI agents — Director, Writer, Cinematographer, Composer,
          Editor — carrying one idea all the way to a finished film.
        </motion.p>

        <motion.a
          href="/studio"
          initial={{ opacity: 0, y: 16, scale: 0.9 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.92 }}
          transition={{ duration: 0.5, delay: 0.6, type: 'spring', bounce: 0.5 }}
          className="glow-brand relative mt-9 inline-flex items-center rounded-full bg-gradient-to-r from-brand-1 to-brand-2 px-8 py-4 text-sm font-semibold text-[#1c1206]"
        >
          Launch the studio
        </motion.a>
      </motion.div>
    </section>
  );
}
