import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, CheckCheck, RotateCcw } from 'lucide-react';
import type { ProjectOverview } from '@osai/core';
import { toast } from 'sonner';

import { api, type SceneDetail } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { PrimarySurface } from '@/components/ui/primary-surface';
import { Section } from '@/components/ui/section';
import { Badge } from '@/components/ui/badge';
import { STATUS_LABEL, STATUS_TONE } from '@/components/SceneCard';
import { cn } from '@/lib/utils';

/**
 * Kai's workspace: the final review checkpoint, plus the one real editorial action
 * Kai owns — trimming the assembled cut (reorder, or leave a scene out without
 * retiring it from the script). `overview.timeline.order` is the actual sequence;
 * `manual` is true once a trim has been made (see `Project.trimTimeline`), after
 * which upstream scene changes flag the timeline stale instead of silently
 * overwriting the trim. Review/approve reuses `approveAll`/`acknowledgeScene`
 * exactly as `TopBar`/`ScenePanel` already do; that status lives in the side
 * rail since the sequence itself is the actual work surface.
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
    <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[1fr_320px]">
      <PrimarySurface
        role="Editor"
        title="Assembled sequence"
        action={
          overview.timeline.manual ? (
            <Button size="sm" variant="ghost" className="gap-1.5" onClick={resetTimeline}>
              <RotateCcw className="size-3.5" />
              Reset to auto-assembled
            </Button>
          ) : undefined
        }
      >
        {overview.scenes.length > 0 && (
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
        )}

        {excluded.length > 0 && (
          <>
            <p className="mt-4 mb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">Not in the cut</p>
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
      </PrimarySurface>

      <Section
        title="Final review"
        action={<Badge variant="outline">{overview.timeline.manual ? 'Manually trimmed' : 'Auto-assembled'}</Badge>}
      >
        <p className="text-sm text-muted-foreground">
          {overview.scenes.length === 0
            ? 'No scenes yet.'
            : needsAttentionCount === 0
              ? 'Everything in this cut is approved.'
              : `${needsAttentionCount} scene${needsAttentionCount === 1 ? '' : 's'} need${needsAttentionCount === 1 ? 's' : ''} attention.`}
        </p>
        <Button
          className="mt-3 gap-1.5"
          disabled={busy || overview.scenes.length === 0}
          onClick={approveAll}
        >
          <CheckCheck className="size-4" />
          Approve all
        </Button>
      </Section>
    </div>
  );
}
