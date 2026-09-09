import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Clapperboard, Loader2 } from 'lucide-react';
import type { SceneSummary } from '@osai/core';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

type Stage = 'idea' | 'director' | 'writer' | 'cinematographer';

interface StylePreview {
  readonly tone: string;
  readonly palette: string;
  readonly pacing: string;
  readonly mood: string;
}

const fadeSlide = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -10 },
  transition: { duration: 0.25, ease: 'easeOut' as const },
};

/**
 * One prompt, staged agents, accept between each: Director sets the brief, Writer
 * drafts the script from idea + brief, Cinematographer plans every scene. Only
 * mounted while a project has no scenes yet (see ProjectPage) — client-side-only
 * state machine, nothing about "wizard stage" is persisted on the graph.
 */
export function ProjectWizard({ projectId, onComplete }: { projectId: string; onComplete: () => void }) {
  const [stage, setStage] = useState<Stage>('idea');
  const [idea, setIdea] = useState('');
  const [busy, setBusy] = useState(false);
  const [style, setStyle] = useState<StylePreview | null>(null);
  const [script, setScript] = useState('');
  const [planProgress, setPlanProgress] = useState<{ done: number; total: number } | null>(null);

  const runDirector = async () => {
    if (!idea.trim()) return;
    setBusy(true);
    try {
      const result = await api.generateStyle(projectId, idea.trim());
      setStyle(result.style);
      setStage('director');
    } catch (e) {
      toast.error('Could not generate direction', { description: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const runWriter = async () => {
    setBusy(true);
    try {
      const result = await api.generateScript(projectId, idea.trim());
      setScript(result.script);
      setStage('writer');
    } catch (e) {
      toast.error('Could not draft the script', { description: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const acceptScript = async () => {
    setBusy(true);
    try {
      const result = await api.saveScript(
        projectId,
        script.split(/\n\s*\n/).map((text) => ({ text: text.trim() })).filter((s) => s.text),
      );
      const scenes: readonly SceneSummary[] = result.overview?.scenes ?? [];
      setStage('cinematographer');
      setPlanProgress({ done: 0, total: scenes.length });
      for (const [i, scene] of scenes.entries()) {
        await api.generatePlan(projectId, scene.sceneId);
        setPlanProgress({ done: i + 1, total: scenes.length });
      }
      toast.success('Ready — scenes planned');
      onComplete();
    } catch (e) {
      toast.error('Could not finish setup', { description: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const progressPct = planProgress ? Math.round((planProgress.done / Math.max(planProgress.total, 1)) * 100) : 0;

  return (
    <div className="mx-auto mt-16 max-w-xl">
      <motion.div
        className="mb-4 flex items-center gap-2 text-muted-foreground"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
      >
        <Clapperboard className="size-4" />
        <span className="text-sm font-medium">
          {stage === 'idea' && 'What’s the idea?'}
          {stage === 'director' && 'Direction'}
          {stage === 'writer' && 'Script'}
          {stage === 'cinematographer' && 'Planning scenes'}
        </span>
      </motion.div>

      <AnimatePresence mode="wait">
        {stage === 'idea' && (
          <motion.div key="idea" {...fadeSlide} className="flex items-center gap-2">
            <Input
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runDirector()}
              placeholder="One line is enough — a lighthouse keeper's last night on duty"
              className="h-9"
            />
            <Button disabled={busy || !idea.trim()} onClick={runDirector}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : 'Start'}
            </Button>
          </motion.div>
        )}

        {stage === 'director' && style && (
          <motion.div key="director" {...fadeSlide} className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3 rounded-lg border p-4 text-sm">
              {([['Tone', style.tone], ['Palette', style.palette], ['Pacing', style.pacing], ['Mood', style.mood]] as const).map(
                ([label, value], i) => (
                  <motion.div
                    key={label}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.06 }}
                  >
                    <span className="text-muted-foreground">{label}</span>
                    <p>{value}</p>
                  </motion.div>
                ),
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" disabled={busy} onClick={runDirector}>Regenerate</Button>
              <Button disabled={busy} onClick={runWriter}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : 'Accept'}
              </Button>
            </div>
          </motion.div>
        )}

        {stage === 'writer' && (
          <motion.div key="writer" {...fadeSlide} className="flex flex-col gap-3">
            <Textarea value={script} onChange={(e) => setScript(e.target.value)} rows={12} />
            <div className="flex gap-2">
              <Button variant="outline" disabled={busy} onClick={runWriter}>Regenerate</Button>
              <Button disabled={busy || !script.trim()} onClick={acceptScript}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : 'Accept'}
              </Button>
            </div>
          </motion.div>
        )}

        {stage === 'cinematographer' && (
          <motion.div key="cinematographer" {...fadeSlide} className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Planning scene {Math.min((planProgress?.done ?? 0) + 1, planProgress?.total ?? 1)} of{' '}
              {planProgress?.total ?? '…'}
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
              <motion.div
                className="h-full bg-primary"
                animate={{ width: `${progressPct}%` }}
                transition={{ duration: 0.3 }}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
