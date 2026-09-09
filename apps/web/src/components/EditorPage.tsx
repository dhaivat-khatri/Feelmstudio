import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowDown, ArrowUp, CheckCheck, RotateCcw } from 'lucide-react';
import { AGENT_PERSONAS, type ProjectOverview } from '@osai/core';
import { toast } from 'sonner';

import { api, type SceneDetail } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { STATUS_LABEL, STATUS_TONE } from '@/components/SceneCard';
import { cn } from '@/lib/utils';

const persona = AGENT_PERSONAS.Editor;

/**
 * Kai's workspace: the final review checkpoint, plus the one real editorial action
 * Kai owns — trimming the assembled cut (reorder, or leave a scene out without
 * retiring it from the script). `overview.timeline.order` is the actual sequence;
 * `manual` is true once a trim has been made (see `Project.trimTimeline`), after
 * which upstream scene changes flag the timeline stale instead of silently
 * overwriting the trim. Review/approve reuses `approveAll`/`acknowledgeScene`
 * exactly as `TopBar`/`ScenePanel` already do.
 */
export function EditorPage({
  projectId,
  overview,
  onChanged,
}: {
  projectId: string;
  overview: ProjectOverview;
  onChanged: () => void;
}) {
  const [details, setDetails] = useState<ReadonlyMap<string, SceneDetail>>(new Map());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all(overview.scenes.map((s) => api.getScene(projectId, s.sceneId))).then((scenes) => {
      setDetails(new Map(scenes.map((d) => [d.sceneId, d])));
    });
  }, [projectId, overview.scenes]);

  const needsAttentionCount = overview.scenes.filter((s) => s.needsAttention).length;

  const approveAll = async () => {
    setBusy(true);
    try {
      const result = await api.approveAll(projectId);
      toast.success(`Approved ${result.approved} item${result.approved === 1 ? '' : 's'}`);
      onChanged();
    } catch (e) {
      toast.error('Could not approve', { description: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const acknowledge = async (sceneId: string) => {
    await api.acknowledgeScene(projectId, sceneId);
    onChanged();
  };

  const applyOrder = async (order: readonly string[]) => {
    try {
      await api.trimTimeline(projectId, order);
      onChanged();
    } catch (e) {
      toast.error('Could not update the cut', { description: String(e) });
    }
  };

  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= overview.timeline.order.length) return;
    const next = [...overview.timeline.order];
    [next[index], next[target]] = [next[target]!, next[index]!];
    applyOrder(next);
  };

  const exclude = (sceneId: string) => applyOrder(overview.timeline.order.filter((id) => id !== sceneId));
  const include = (sceneId: string) => applyOrder([...overview.timeline.order, sceneId]);

  const resetTimeline = async () => {
    try {
      await api.resetTimeline(projectId);
      onChanged();
      toast.success('Reset to auto-assembled');
    } catch (e) {
      toast.error('Could not reset', { description: String(e) });
    }
  };

  const sceneById = new Map(overview.scenes.map((s) => [s.sceneId, s]));
  const included = overview.timeline.order.flatMap((id) => {
    const scene = sceneById.get(id);
    return scene ? [scene] : [];
  });
  const excluded = overview.scenes.filter((s) => !overview.timeline.order.includes(s.sceneId));

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <motion.div
        className="flex items-center gap-3 rounded-lg border p-4"
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <span
          className="flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white"
          style={{ backgroundColor: persona.color }}
        >
          {persona.name
            .split(' ')
            .map((w) => w[0])
            .join('')}
        </span>
        <div>
          <p className="text-sm font-semibold">
            {persona.name} · {persona.role}
          </p>
          <p className="text-xs text-muted-foreground">{persona.tagline}</p>
        </div>
      </motion.div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Final Review</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {overview.scenes.length === 0
              ? 'No scenes yet.'
              : needsAttentionCount === 0
                ? 'Everything in this cut is approved.'
                : `${needsAttentionCount} scene${needsAttentionCount === 1 ? '' : 's'} need${needsAttentionCount === 1 ? 's' : ''} attention.`}
          </p>
          <Button size="sm" variant="secondary" className="gap-1.5" disabled={busy || overview.scenes.length === 0} onClick={approveAll}>
            <CheckCheck className="size-4" />
            Approve all
          </Button>
        </CardContent>
      </Card>

      {overview.scenes.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
            <div className="flex items-center gap-2">
              <CardTitle className="text-sm">Assembled Sequence</CardTitle>
              <Badge variant="outline">{overview.timeline.manual ? 'Manually trimmed' : 'Auto-assembled'}</Badge>
            </div>
            {overview.timeline.manual && (
              <Button size="sm" variant="ghost" className="gap-1.5" onClick={resetTimeline}>
                <RotateCcw className="size-3.5" />
                Reset to auto-assembled
              </Button>
            )}
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col divide-y">
              {included.map((scene, i) => {
                const detail = details.get(scene.sceneId);
                const videoUrl = detail?.parts.video.mediaUrl;
                const imageUrl = detail?.parts.image.mediaUrl;
                return (
                  <li key={scene.sceneId} className="flex items-center gap-3 py-2.5">
                    <div className="flex h-12 w-20 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted text-[10px] text-muted-foreground">
                      {videoUrl ? (
                        <video src={videoUrl} muted loop playsInline className="h-full w-full object-cover" />
                      ) : imageUrl ? (
                        <img src={imageUrl} alt="" className="h-full w-full object-cover" />
                      ) : (
                        'No media'
                      )}
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm">
                        Scene {scene.ordinal}
                        {scene.heading ? ` — ${scene.heading}` : ''}
                      </span>
                      <Badge className={cn('mt-1 w-fit', STATUS_TONE[scene.status] ?? STATUS_TONE.notStarted)}>
                        {STATUS_LABEL[scene.status] ?? scene.status}
                      </Badge>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button size="icon-sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} title="Move earlier">
                        <ArrowUp className="size-3.5" />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled={i === included.length - 1}
                        onClick={() => move(i, 1)}
                        title="Move later"
                      >
                        <ArrowDown className="size-3.5" />
                      </Button>
                      {scene.needsAttention && (
                        <Button size="sm" variant="outline" onClick={() => acknowledge(scene.sceneId)}>
                          Approve as-is
                        </Button>
                      )}
                      <Button size="sm" variant="outline" onClick={() => exclude(scene.sceneId)}>
                        Exclude
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>

            {excluded.length > 0 && (
              <>
                <p className="mb-1.5 mt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Not in the cut
                </p>
                <ul className="flex flex-col divide-y">
                  {excluded.map((scene) => (
                    <li key={scene.sceneId} className="flex items-center justify-between gap-3 py-2 text-sm text-muted-foreground">
                      <span className="truncate">
                        Scene {scene.ordinal}
                        {scene.heading ? ` — ${scene.heading}` : ''}
                      </span>
                      <Button size="sm" variant="outline" onClick={() => include(scene.sceneId)}>
                        Include
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
