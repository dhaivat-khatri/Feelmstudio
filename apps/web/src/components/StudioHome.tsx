import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { AGENT_PERSONAS, type PersonaRole, type ProjectOverview } from '@osai/core';
import type { ProjectListing } from '@osai/persistence';

import { api } from '@/lib/api';
import { BrandMark } from '@/components/BrandMark';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

const PIPELINE_ORDER: readonly PersonaRole[] = ['Director', 'Writer', 'Cinematographer', 'Composer', 'Editor'];

function currentStage(overview: ProjectOverview): PersonaRole | 'Complete' {
  return PIPELINE_ORDER.find((role) => overview.agentStatus[role] !== 'approved') ?? 'Complete';
}

function progressPct(overview: ProjectOverview): number {
  const counts = Object.values(overview.counts);
  const total = counts.reduce((a, b) => a + b, 0);
  return total === 0 ? 0 : Math.round((overview.counts.approved / total) * 100);
}

/**
 * The user's home: one card per project, showing production progress at a glance —
 * not a generic dashboard, a status board over the same `overview()` every agent
 * page already reads (idea/style/counts/agentStatus), fetched once per project here.
 * Per the brief this was built from: "don't make the dashboard the product — the
 * production itself is the product," so this stays a launch pad, not a chart wall.
 */
export function StudioHome({
  projects,
  onSelect,
}: {
  projects: readonly ProjectListing[];
  onSelect: (id: string) => void;
}) {
  const [overviews, setOverviews] = useState<ReadonlyMap<string, ProjectOverview>>(new Map());

  useEffect(() => {
    Promise.all(projects.map((p) => api.getProject(p.id).catch(() => null))).then((results) => {
      setOverviews(new Map(results.flatMap((o, i) => (o ? [[projects[i]!.id, o] as const] : []))));
    });
  }, [projects]);

  if (projects.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-muted-foreground">
        <BrandMark size={44} className="text-primary/90" />
        <p className="text-sm">Name a film on the left, and the studio starts up.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h1 className="mb-5 text-lg font-semibold">Production Studio</h1>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {projects.map((p, i) => {
          const overview = overviews.get(p.id);
          const stage = overview ? currentStage(overview) : null;
          const persona = stage && stage !== 'Complete' ? AGENT_PERSONAS[stage] : null;
          const pending = overview?.needsAttention.length ?? 0;

          return (
            <motion.div
              key={p.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, delay: Math.min(i, 10) * 0.04 }}
            >
              <Card>
                <CardContent className="flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-semibold">{p.title}</p>
                      {overview?.style.format && (
                        <p className="truncate text-xs text-muted-foreground">
                          {overview.style.format}
                          {overview.style.genre ? ` · ${overview.style.genre}` : ''}
                          {overview.style.runtimeMinutes ? ` · ${overview.style.runtimeMinutes} min` : ''}
                        </p>
                      )}
                    </div>
                    <Badge variant="outline" className="shrink-0 capitalize">
                      {p.lifecycle}
                    </Badge>
                  </div>

                  {overview && (
                    <>
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <span>Production Progress</span>
                          <span>{progressPct(overview)}%</span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full bg-primary transition-[width]"
                            style={{ width: `${progressPct(overview)}%` }}
                          />
                        </div>
                      </div>

                      <div className="flex items-center justify-between text-xs">
                        <span className="flex items-center gap-1.5 text-muted-foreground">
                          Current stage:
                          {persona ? (
                            <span className="flex items-center gap-1 font-medium text-foreground">
                              <span className="size-1.5 rounded-full" style={{ backgroundColor: persona.color }} />
                              {persona.role}
                            </span>
                          ) : (
                            <span className="font-medium text-foreground">Complete</span>
                          )}
                        </span>
                        {pending > 0 && (
                          <span className="text-status-attention">
                            ⚠ {pending} needs attention
                          </span>
                        )}
                      </div>
                    </>
                  )}

                  <Button size="sm" className="mt-1 self-start" onClick={() => onSelect(p.id)}>
                    Continue Production
                  </Button>
                </CardContent>
              </Card>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
