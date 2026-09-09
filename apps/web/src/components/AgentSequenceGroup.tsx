import { useEffect, useRef, useState } from 'react';
import { animate } from 'animejs';
import { AGENT_PERSONAS, type PersonaRole } from '@osai/core';
import { prefersReducedMotion } from '@/lib/motion-prefs';

const FRAME_COUNT = 300;

export interface AgentSpec {
  readonly slug: string;
  readonly role: PersonaRole;
  readonly description: string;
}

const framePath = (slug: string, i: number) => `/agents/${slug}/frame-${String(i + 1).padStart(3, '0')}.jpg`;

/**
 * All five agents as ONE continuous scroll-pinned sequence, not five separate
 * `sticky` sections stacked back to back.
 *
 * That was tried first and had a real, structural bug: a `position: sticky`
 * element inside an Nvh container only stays pinned for (N - 100)vh of scroll
 * — past that it un-sticks and scrolls away with the rest of its own
 * container, *before* the next section's container even reaches the top of
 * the viewport. Stack five of those and you get five real gaps where nothing
 * is pinned and the page background shows through — confirmed by reading
 * `getBoundingClientRect()` on both the outgoing and incoming sticky elements
 * at the transition point: both were off-screen simultaneously.
 *
 * The fix: one `h-[1500vh]` wrapper, one `sticky` viewport, one continuous
 * 0→1 scroll progress split into 5 equal slices. Which agent's frames draw,
 * and which caption is visible, is derived from that single progress value —
 * there is never a boundary where the pinned element itself changes, so
 * there is nothing to gap.
 *
 * Caption opacity/position is set imperatively via refs from the same scroll
 * handler that drives the canvas, not via a `useTransform` per agent — the
 * agent list is fixed length, but computing hooks inside `.map()` still
 * violates the Rules of Hooks, so this stays consistent with how the canvas
 * itself is already driven (one imperative scroll handler, no per-item
 * subscriptions).
 */
export function AgentSequenceGroup({ agents }: { agents: readonly AgentSpec[] }) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const captionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const numberRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const imagesRef = useRef<HTMLImageElement[][]>(agents.map(() => []));
  const startedRef = useRef<boolean[]>(agents.map(() => false));
  const activeRef = useRef(0);
  const progressRef = useRef(0);
  const [loadedCounts, setLoadedCounts] = useState<number[]>(agents.map(() => 0));
  const [activeIndex, setActiveIndex] = useState(0);

  const n = agents.length;

  const draw = (agentIdx: number, frameIdx: number) => {
    const canvas = canvasRef.current;
    const img = imagesRef.current[agentIdx]?.[Math.round(frameIdx)];
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !img || !img.complete || img.naturalWidth === 0) return;
    const cw = canvas.width;
    const ch = canvas.height;
    const scale = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
    const dw = img.naturalWidth * scale;
    const dh = img.naturalHeight * scale;
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(img, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
  };

  // Fade in over the first 8% of an agent's own slice, stay, fade out over
  // the last 8% — captions for every OTHER agent stay at opacity 0.
  const updateCaptions = (progress: number) => {
    for (let i = 0; i < n; i++) {
      const el = captionRefs.current[i];
      if (!el) continue;
      const sliceStart = i / n;
      const sliceEnd = (i + 1) / n;
      const fadeSpan = (sliceEnd - sliceStart) * 0.08;
      let opacity = 0;
      let y = 20;
      if (progress >= sliceStart - fadeSpan && progress <= sliceEnd + fadeSpan) {
        if (progress < sliceStart + fadeSpan) {
          const t = Math.min(Math.max((progress - sliceStart) / fadeSpan, 0), 1);
          opacity = t;
          y = 20 * (1 - t);
        } else if (progress > sliceEnd - fadeSpan) {
          const t = Math.min(Math.max((sliceEnd - progress) / fadeSpan, 0), 1);
          opacity = t;
          y = -12 * (1 - t);
        } else {
          opacity = 1;
          y = 0;
        }
      }
      el.style.opacity = String(opacity);
      el.style.transform = `translateY(${y}px)`;
    }
  };

  const startLoading = (agentIdx: number) => {
    if (agentIdx < 0 || agentIdx >= n || startedRef.current[agentIdx]) return;
    startedRef.current[agentIdx] = true;
    const slug = agents[agentIdx]!.slug;
    for (let i = 0; i < FRAME_COUNT; i++) {
      const img = new Image();
      img.onload = () => {
        imagesRef.current[agentIdx]![i] = img;
        setLoadedCounts((prev) => {
          const next = [...prev];
          next[agentIdx] = (next[agentIdx] ?? 0) + 1;
          return next;
        });
      };
      img.src = framePath(slug, i);
    }
  };

  useEffect(() => {
    startLoading(0);
    startLoading(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persona badge digit-roll: counts up to the incoming agent's ordinal as it
  // becomes active, an odometer-style tween anime.js handles far more simply
  // than framer-motion (animating a plain number via `onUpdate`, not a DOM
  // style property). Fires at most 4 times per page (n - 1 transitions).
  useEffect(() => {
    const el = numberRefs.current[activeIndex];
    if (!el) return;
    if (prefersReducedMotion()) {
      el.textContent = String(activeIndex + 1).padStart(2, '0');
      return;
    }
    const counter = { value: 0 };
    const anim = animate(counter, {
      value: activeIndex + 1,
      duration: 550,
      ease: 'outExpo',
      onUpdate: () => {
        el.textContent = String(Math.round(counter.value)).padStart(2, '0');
      },
    });
    // Also the StrictMode guard: this effect re-fires legitimately on every
    // activeIndex change (not a once-ever mount), so pausing the in-flight
    // tween on cleanup — rather than a "played once" ref — is what's actually
    // correct here. It doubles as the fix for both problems: StrictMode's
    // dev-only mount→cleanup→remount stops the first tween before the second
    // starts, and a real unmount mid-count stops writing to a detached node.
    return () => {
      anim.pause();
    };
  }, [activeIndex]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas?.parentElement || !wrapper) return;

    const applyProgress = (progress: number) => {
      progressRef.current = progress;
      const raw = Math.min(Math.max(progress, 0), 1) * n;
      const clamped = Math.min(raw, n - 1e-6);
      const idx = Math.min(Math.floor(clamped), n - 1);
      const local = clamped - idx;
      if (idx !== activeRef.current) {
        activeRef.current = idx;
        setActiveIndex(idx);
      }
      startLoading(idx);
      startLoading(idx + 1);
      draw(idx, local * (FRAME_COUNT - 1));
      updateCaptions(progress);
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.parentElement!.getBoundingClientRect();
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      applyProgress(progressRef.current);
    };

    const updateProgress = () => {
      const rect = wrapper.getBoundingClientRect();
      const span = rect.height - window.innerHeight;
      const p = span > 0 ? Math.min(Math.max(-rect.top / span, 0), 1) : 0;
      applyProgress(p);
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
  }, []);

  const activeReady = (loadedCounts[activeIndex] ?? 0) === FRAME_COUNT;

  return (
    <section ref={wrapperRef} className="relative" style={{ height: `${n * 300}vh` }}>
      <div className="sticky top-0 flex h-screen flex-col overflow-hidden bg-black">
        <canvas ref={canvasRef} className="absolute inset-0 size-full" />

        <div className="pointer-events-none absolute inset-0 z-[5] bg-gradient-to-b from-black/75 via-transparent to-black/85" />
        <div className="pointer-events-none absolute inset-0 z-[5] bg-gradient-to-t from-black/40 via-transparent to-transparent" />

        {agents.map((agent, i) => {
          const persona = AGENT_PERSONAS[agent.role];
          return (
            <div
              key={agent.slug}
              ref={(el) => {
                captionRefs.current[i] = el;
              }}
              style={{ opacity: 0, transition: 'opacity 0.05s linear' }}
              className="pointer-events-none absolute inset-0 z-10"
            >
              <div className="flex items-center gap-2 px-6 pt-24 sm:px-10">
                <span
                  className="flex size-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
                  style={{ backgroundColor: persona.color, boxShadow: `0 0 24px ${persona.color}66` }}
                >
                  {persona.name
                    .split(' ')
                    .map((w) => w[0])
                    .join('')}
                </span>
                <span className="text-xs font-medium tracking-[0.2em] text-white/60">
                  <span
                    ref={(el) => {
                      numberRefs.current[i] = el;
                    }}
                  >
                    {i === 0 ? '01' : '00'}
                  </span>{' '}
                  / {String(n).padStart(2, '0')} — {persona.role.toUpperCase()}
                </span>
              </div>

              <div className="absolute inset-x-0 bottom-16 flex flex-col items-center px-6 text-center sm:bottom-20">
                <h3 className="text-2xl font-semibold text-white sm:text-4xl">{persona.name}</h3>
                <p className="mx-auto mt-3 max-w-xl text-balance text-white/80 sm:text-lg">{agent.description}</p>
              </div>
            </div>
          );
        })}

        {!activeReady && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-black text-white">
            <div className="h-0.5 w-48 overflow-hidden rounded-full bg-white/15">
              <div
                className="h-full bg-white transition-[width] duration-150"
                style={{ width: `${Math.round(((loadedCounts[activeIndex] ?? 0) / FRAME_COUNT) * 100)}%` }}
              />
            </div>
            <p className="text-xs tracking-wide text-white/50">
              Loading {Math.round(((loadedCounts[activeIndex] ?? 0) / FRAME_COUNT) * 100)}%
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
