import { useEffect, useRef, useState } from 'react';
import { motion, useMotionValue, useMotionValueEvent, useTransform } from 'framer-motion';

const FRAME_COUNT = 240;
const framePath = (i: number) => `/sequence/frame-${String(i + 1).padStart(3, '0')}.jpg`;

/**
 * The landing page's hero: an Apple-style scroll-scrubbed frame sequence
 * (product-page technique — AirPods, Vision Pro) with the pitch copy overlaid
 * as a scroll-linked fade rather than a separate static section above it. A
 * tall (400vh) wrapper holds a `sticky` canvas that stays pinned while scroll
 * progress maps 1:1 onto the frame index. No easing on that mapping —
 * playback tracks the scrollbar exactly; smoothing here would read as
 * lag/stutter.
 *
 * Progress is computed manually off `getBoundingClientRect` on every scroll
 * event rather than via framer-motion's `useScroll({ target })` — that target-
 * rect tracking produced non-monotonic values on this page (opacity rising
 * again mid-scroll instead of staying at 0), most likely from a measurement
 * getting invalidated by the canvas resize/image-load layout. A raw scroll
 * listener has no such ambiguity.
 */
export function ScrollSequence() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imagesRef = useRef<HTMLImageElement[]>([]);
  const [loaded, setLoaded] = useState(0);
  const [failed, setFailed] = useState(0);
  const ready = loaded + failed === FRAME_COUNT;
  const pct = Math.round(((loaded + failed) / FRAME_COUNT) * 100);

  const scrollYProgress = useMotionValue(0);
  const frameIndex = useTransform(scrollYProgress, [0, 1], [0, FRAME_COUNT - 1]);

  // Intro copy: on screen at rest, fades and drifts up as the sequence starts
  // playing — the same "read it, then it gets out of the way" beat Apple uses.
  const introOpacity = useTransform(scrollYProgress, [0, 0.14], [1, 0]);
  const introY = useTransform(scrollYProgress, [0, 0.14], [0, -32]);
  // Closing statement: only appears once the sequence has essentially finished.
  const outroOpacity = useTransform(scrollYProgress, [0.86, 0.96], [0, 1]);
  const outroY = useTransform(scrollYProgress, [0.86, 0.96], [24, 0]);
  const scrollHintOpacity = useTransform(scrollYProgress, [0, 0.06], [1, 0]);

  // Three title cards pinned through the middle of the scrub — the beat Apple
  // uses to give a wordless product animation a spine. Each fades in, holds a
  // beat, fades out before the next.
  const beat1 = useTransform(scrollYProgress, [0.18, 0.25, 0.34, 0.4], [0, 1, 1, 0]);
  const beat1y = useTransform(scrollYProgress, [0.18, 0.4], [28, -28]);
  const beat2 = useTransform(scrollYProgress, [0.42, 0.49, 0.58, 0.64], [0, 1, 1, 0]);
  const beat2y = useTransform(scrollYProgress, [0.42, 0.64], [28, -28]);
  const beat3 = useTransform(scrollYProgress, [0.66, 0.73, 0.8, 0.85], [0, 1, 1, 0]);
  const beat3y = useTransform(scrollYProgress, [0.66, 0.85], [28, -28]);

  const draw = (index: number) => {
    const canvas = canvasRef.current;
    const img = imagesRef.current[Math.round(index)];
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !img || !img.complete || img.naturalWidth === 0) return;
    // "Cover" crop, same as CSS object-fit: cover — fills edge to edge on any
    // viewport size with no letterboxing, which is what keeps this sharp and
    // centered on mobile.
    const cw = canvas.width;
    const ch = canvas.height;
    const scale = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
    const dw = img.naturalWidth * scale;
    const dh = img.naturalHeight * scale;
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(img, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
  };

  useMotionValueEvent(frameIndex, 'change', (latest) => draw(latest));

  useEffect(() => {
    let cancelled = false;
    for (let i = 0; i < FRAME_COUNT; i++) {
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        imagesRef.current[i] = img;
        setLoaded((n) => n + 1);
      };
      img.onerror = () => {
        if (!cancelled) setFailed((n) => n + 1);
      };
      img.src = framePath(i);
    }
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas?.parentElement || !wrapper) return;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.parentElement!.getBoundingClientRect();
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      draw(frameIndex.get());
    };

    // rect.top runs from 0 (wrapper's top edge at the viewport's top edge) to
    // -(wrapper height - viewport height) (wrapper's bottom edge at the
    // viewport's bottom edge) — exactly the pinned scroll span.
    const updateProgress = () => {
      const rect = wrapper.getBoundingClientRect();
      const span = rect.height - window.innerHeight;
      const p = span > 0 ? Math.min(Math.max(-rect.top / span, 0), 1) : 0;
      scrollYProgress.set(p);
    };

    resize();
    updateProgress();
    window.addEventListener('resize', resize);
    window.addEventListener('resize', updateProgress);
    window.addEventListener('scroll', updateProgress, { passive: true });
    return () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('resize', updateProgress);
      window.removeEventListener('scroll', updateProgress);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  return (
    <section ref={wrapperRef} className="relative h-[400vh]">
      <div className="sticky top-0 flex h-screen items-center justify-center overflow-hidden bg-black">
        <canvas ref={canvasRef} className="film-grade absolute inset-0 size-full" />

        {/* Scrim — the frames vary from light to dark backgrounds; without this,
            overlay text loses contrast against the brighter ones. One clean
            bottom-anchored gradient, not a stack of vignettes. */}
        <div className="pointer-events-none absolute inset-0 z-[5] bg-gradient-to-b from-black/10 via-black/25 to-black/70" />

        {/* Pinned title cards through the middle of the scrub. */}
        <motion.p
          style={{ opacity: beat1, y: beat1y }}
          className="hero-display pointer-events-none absolute z-10 max-w-5xl px-6 text-center uppercase leading-[0.92] text-white text-[clamp(2.4rem,9vw,6.5rem)]"
        >
          You write a sentence.
        </motion.p>
        <motion.p
          style={{ opacity: beat2, y: beat2y }}
          className="hero-display pointer-events-none absolute z-10 max-w-5xl px-6 text-center uppercase leading-[0.92] text-white text-[clamp(2.4rem,9vw,6.5rem)]"
        >
          Five agents pick it up.
        </motion.p>
        <motion.p
          style={{ opacity: beat3, y: beat3y }}
          className="hero-display pointer-events-none absolute z-10 max-w-5xl px-6 text-center uppercase leading-[0.92] text-white text-[clamp(2.4rem,9vw,6.5rem)]"
        >
          It comes back a film.
        </motion.p>

        <motion.div
          style={{ opacity: introOpacity, y: introY }}
          className="pointer-events-none relative z-10 flex w-full flex-col items-center px-4 text-center"
        >
          <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.2em] text-brand-1">
            Feelm Studio
          </p>
          <h1 className="hero-display w-full text-balance uppercase leading-[0.86] text-white text-[clamp(3.2rem,13vw,11.5rem)]">
            <span className="block">Idea to</span>
            <span className="block">published film</span>
          </h1>
          <p className="mt-8 max-w-sm text-balance text-sm text-white/60">
            Type a sentence. A director, a writer, a cinematographer, a composer, and an editor
            take it from there.
          </p>
          <a
            href="/studio"
            className="pointer-events-auto mt-9 inline-flex items-center rounded-full bg-brand-1 px-7 py-3.5 text-sm font-semibold text-[#17100a] transition-colors hover:bg-brand-2"
          >
            Launch the studio
          </a>
        </motion.div>

        <motion.div
          style={{ opacity: scrollHintOpacity }}
          className="pointer-events-none absolute bottom-8 z-10 flex flex-col items-center gap-2 text-white/50"
        >
          <span className="text-[11px] uppercase tracking-[0.2em]">Scroll</span>
          <motion.span
            animate={{ y: [0, 6, 0] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
            className="h-8 w-px bg-gradient-to-b from-white/60 to-transparent"
          />
        </motion.div>

        <motion.div
          style={{ opacity: outroOpacity, y: outroY }}
          className="pointer-events-none absolute bottom-16 z-10 px-6 text-center"
        >
          <p className="text-balance text-lg font-medium text-white sm:text-xl">
            Nobody touched a camera. It's still your film.
          </p>
        </motion.div>

        {!ready && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-black text-white">
            <div className="h-0.5 w-48 overflow-hidden rounded-full bg-white/15">
              <div className="h-full bg-white transition-[width] duration-150" style={{ width: `${pct}%` }} />
            </div>
            <p className="text-xs tracking-wide text-white/50">Loading {pct}%</p>
          </div>
        )}

        {ready && failed > 0 && (
          <p className="absolute bottom-2 z-10 text-[10px] text-white/30">
            Some frames failed to load — playback may skip.
          </p>
        )}
      </div>
    </section>
  );
}
