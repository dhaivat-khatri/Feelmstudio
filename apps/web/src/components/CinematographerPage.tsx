import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Loader2 } from 'lucide-react';
import { AGENT_PERSONAS, type ProjectOverview, type SceneId, type ScenePlanPayload } from '@osai/core';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { STATUS_LABEL, STATUS_TONE } from '@/components/SceneCard';
import { cn } from '@/lib/utils';

const persona = AGENT_PERSONAS.Cinematographer;

function planSummary(plan: ScenePlanPayload | undefined): string | null {
  if (!plan) return null;
  const parts = [plan.shotType, plan.framing, plan.cameraMove].filter(Boolean);
  if (plan.durationSeconds !== undefined) parts.push(`${plan.durationSeconds}s`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Revo's workspace: plan every scene's shot (shot type/framing/camera move) in one
 * pass, reusing the same `POST .../plan/generate` call `ScenePanel`'s per-scene
 * "Generate" button already uses — this page just sequences it across all scenes
 * (the wizard does this once during setup; this is the revisitable version) and
 * shows the resulting shot list at a glance.
 */
export function CinematographerPage({
  projectId,
  overview,
  onChanged,
  onContinue,
}: {
  projectId: string;
  overview: ProjectOverview;
  onChanged: () => void;
  /** Hands off to the Composer page. */
  onContinue: () => void;
}) {
  const [plans, setPlans] = useState<ReadonlyMap<SceneId, ScenePlanPayload>>(new Map());
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({});
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);

  const loadPlans = () => {
    Promise.all(
      overview.scenes.map((s) =>
        api.getScene(projectId, s.sceneId).then((d) => [s.sceneId, d.parts.plan.payload as ScenePlanPayload | undefined] as const),
      ),
    ).then((entries) => {
      setPlans(new Map(entries.filter((e): e is [SceneId, ScenePlanPayload] => Boolean(e[1]))));
    });
  };

  useEffect(loadPlans, [projectId, overview.scenes]);

  const planOne = async (sceneId: string) => {
    setRowBusy((b) => ({ ...b, [sceneId]: true }));
    try {
      await api.generatePlan(projectId, sceneId);
      loadPlans();
      onChanged();
    } catch (e) {
      toast.error('Could not generate plan', { description: String(e) });
    } finally {
      setRowBusy((b) => ({ ...b, [sceneId]: false }));
    }
  };

  const planAll = async () => {
    setBulkProgress({ done: 0, total: overview.scenes.length });
    for (const [i, scene] of overview.scenes.entries()) {
      try {
        await api.generatePlan(projectId, scene.sceneId);
      } catch (e) {
        toast.error(`Could not plan scene ${scene.ordinal}`, { description: String(e) });
      }
      setBulkProgress({ done: i + 1, total: overview.scenes.length });
    }
    loadPlans();
    onChanged();
    toast.success('All scenes planned');
    setBulkProgress(null);
  };

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
          <CardTitle className="text-sm">Shot Planning</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {overview.scenes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No scenes yet — draft a script on the Writer page first.</p>
          ) : (
            <div>
              <Button size="sm" disabled={Boolean(bulkProgress)} onClick={planAll}>
                {bulkProgress ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Planning {bulkProgress.done + 1} of {bulkProgress.total}
                  </>
                ) : (
                  'Plan all scenes'
                )}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {overview.scenes.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Shot List</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col divide-y">
              {overview.scenes.map((scene) => {
                const summary = planSummary(plans.get(scene.sceneId));
                return (
                  <li key={scene.sceneId} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate">
                        Scene {scene.ordinal}
                        {scene.heading ? ` — ${scene.heading}` : ''}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {summary ?? 'Not planned yet'}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge className={cn(STATUS_TONE[scene.status] ?? STATUS_TONE.notStarted)}>
                        {STATUS_LABEL[scene.status] ?? scene.status}
                      </Badge>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={rowBusy[scene.sceneId] || Boolean(bulkProgress)}
                        onClick={() => planOne(scene.sceneId)}
                      >
                        {rowBusy[scene.sceneId] ? <Loader2 className="size-4 animate-spin" /> : summary ? 'Redo' : 'Plan'}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      {overview.scenes.length > 0 && (
        <div className="flex justify-end">
          <Button variant="secondary" size="sm" onClick={onContinue}>
            Continue to Composer →
          </Button>
        </div>
      )}
    </div>
  );
}
