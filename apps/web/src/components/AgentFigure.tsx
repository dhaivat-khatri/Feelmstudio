import { useEffect, useRef } from 'react';
import type { PersonaRole } from '@osai/core';

import { cn } from '@/lib/utils';

const FRAME_COUNT = 40;

const framePath = (role: PersonaRole, i: number) =>
  `/agents-cutout/${role.toLowerCase()}/f${String(i).padStart(3, '0')}.webp`;

interface FigureState {
  rotX: number;
  rotY: number;
  frame: number;
  lightX: number;
  lightY: number;
}

/**
 * A crew member as a live, cursor-reactive figure: real cutout frames from
 * their scroll-sequence performance, scrubbed by cursor proximity (approach
 * = they react), tilted in 3D toward the cursor, lit only on their own
 * silhouette (canvas `source-atop`, not a DOM overlay that would glow over
 * transparent space), with a shadow that shifts opposite the tilt and a
 * slow idle bob at rest.
 *
 * Contain-fit, anchored bottom-right, not cover-fit: the hero banner is far
 * wider than it is tall, and a cover-fit crop of a portrait-ish character
 * down to that aspect ratio hides almost the whole figure (head and legs
 * both cut off, only a cropped mid-torso visible). The shadow is drawn
 * directly on the canvas (not a separately-positioned DOM element) so it
 * stays aligned with the character regardless of how much empty space the
 * contain-fit leaves around them.
 */
export function AgentFigure({ role, className }: { role: PersonaRole; className?: string }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const framesRef = useRef<HTMLImageElement[]>([]);

  const stateRef = useRef<FigureState>({ rotX: 0, rotY: 0, frame: 0, lightX: 0.5, lightY: 0.4 });
  const targetRef = useRef<FigureState>({ rotX: 0, rotY: 0, frame: 0, lightX: 0.5, lightY: 0.4 });
  const hoveringRef = useRef(false);

  useEffect(() => {
    framesRef.current = Array.from({ length: FRAME_COUNT }, (_, i) => {
      const img = new Image();
      img.src = framePath(role, i + 1);
      return img;
    });
    stateRef.current.frame = 0;
    targetRef.current.frame = 0;
  }, [role]);

  useEffect(() => {
    const stage = stageRef.current;
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!stage || !wrap || !canvas || !ctx) return;

    const draw = () => {
      const frames = framesRef.current;
      const s = stateRef.current;
      const img = frames[Math.max(0, Math.min(frames.length - 1, Math.round(s.frame)))];
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!img?.complete || img.naturalWidth === 0) return;

      const marginX = canvas.width * 0.03;
      const marginY = canvas.height * 0.05;
      const scale = Math.min((canvas.width - marginX) / img.naturalWidth, (canvas.height - marginY) / img.naturalHeight);
      const dw = img.naturalWidth * scale;
      const dh = img.naturalHeight * scale;
      const dx = canvas.width - dw - marginX;
      const dy = canvas.height - dh - marginY;

      // Contact shadow, drawn under the character's own feet — shifts
      // opposite the tilt to read as a fixed light source overhead.
      const shadowShift = s.rotY * (dw / 90);
      ctx.save();
      ctx.translate(dx + dw / 2 + shadowShift, dy + dh);
      ctx.scale(1, 0.16);
      const shadowGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, dw * 0.42);
      shadowGrad.addColorStop(0, 'rgba(0,0,0,0.5)');
      shadowGrad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = shadowGrad;
      ctx.beginPath();
      ctx.arc(0, 0, dw * 0.42, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.drawImage(img, dx, dy, dw, dh);

      // Light that only lands on the character's own opaque pixels,
      // positioned relative to the character's own bounds (not the full
      // canvas, most of which is empty space around a contain-fit figure).
      ctx.globalCompositeOperation = 'source-atop';
      const lx = dx + s.lightX * dw;
      const ly = dy + s.lightY * dh;
      const grad = ctx.createRadialGradient(lx, ly, 10, lx, ly, dw * 0.7);
      grad.addColorStop(0, 'rgba(255,224,168,0.30)');
      grad.addColorStop(1, 'rgba(255,224,168,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(dx, dy, dw, dh);
      ctx.globalCompositeOperation = 'source-over';
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = stage.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
    };
    resize();
    window.addEventListener('resize', resize);

    let raf = 0;
    const tick = () => {
      const s = stateRef.current;
      const t = targetRef.current;
      const ease = 0.14;
      s.rotX += (t.rotX - s.rotX) * ease;
      s.rotY += (t.rotY - s.rotY) * ease;
      s.frame += (t.frame - s.frame) * (hoveringRef.current ? 0.25 : 0.08);
      s.lightX += (t.lightX - s.lightX) * ease;
      s.lightY += (t.lightY - s.lightY) * ease;

      wrap.style.transform = `rotateY(${s.rotY.toFixed(2)}deg) rotateX(${s.rotX.toFixed(2)}deg)`;
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const onMove = (e: PointerEvent) => {
      const r = stage.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      const d = Math.sqrt(px * px + py * py);
      const t = targetRef.current;
      t.rotY = px * 24;
      t.rotX = -py * 14;
      t.frame = Math.round((1 - Math.min(Math.max(d / 0.62, 0), 1)) * (FRAME_COUNT - 1));
      t.lightX = 0.5 + px * 0.7;
      t.lightY = 0.5 + py * 0.7;
      hoveringRef.current = true;
      wrap.classList.remove('agent-figure-idle');
    };
    const onLeave = () => {
      const t = targetRef.current;
      t.rotX = 0;
      t.rotY = 0;
      t.frame = 0;
      hoveringRef.current = false;
      wrap.classList.add('agent-figure-idle');
    };

    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerleave', onLeave);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      stage.removeEventListener('pointermove', onMove);
      stage.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  return (
    <div ref={stageRef} className={cn('relative', className)} style={{ perspective: 1000 }}>
      <div
        ref={wrapRef}
        className="agent-figure-idle relative size-full"
        style={{ transformStyle: 'preserve-3d' }}
      >
        <canvas ref={canvasRef} className="relative z-10 size-full" />
      </div>
    </div>
  );
}
