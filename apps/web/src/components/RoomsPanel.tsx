import { useCallback, useEffect, useState } from 'react';
import { AGENT_PERSONAS, type Learning, type PersonaRole, type ProjectOverview, type RoomEntry } from '@osai/core';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

const ROLES = Object.keys(AGENT_PERSONAS) as PersonaRole[];

export function RoomsPanel({ projectId, overview }: { projectId: string; overview: ProjectOverview }) {
  const [entries, setEntries] = useState<RoomEntry[]>([]);
  const [learnings, setLearnings] = useState<Record<PersonaRole, Learning[]>>();
  const [scene, setScene] = useState<string>(overview.scenes[0]?.sceneId ?? '');
  const [busy, setBusy] = useState<'scene' | 'all' | null>(null);

  const load = useCallback(() => {
    api
      .getRooms(projectId)
      .then((r) => {
        setEntries(r.entries);
        setLearnings(r.learnings);
      })
      .catch(() => {});
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const runScene = async () => {
    if (!scene) return;
    setBusy('scene');
    try {
      await api.deliberateScene(projectId, scene);
      load();
      toast.success('The crew huddled on this scene.');
    } catch (e) {
      toast.error('Deliberation failed', { description: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const runAll = async () => {
    setBusy('all');
    try {
      await api.deliberateAll(projectId);
      load();
      toast.success('The crew went scene by scene.');
    } catch (e) {
      toast.error('Deliberation failed', { description: String(e) });
    } finally {
      setBusy(null);
    }
  };

  const ordinalOf = (sceneId: string) => overview.scenes.find((s) => s.sceneId === sceneId)?.ordinal ?? '?';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={scene} onValueChange={(v) => setScene(v ?? '')}>
          <SelectTrigger size="sm" className="w-44">
            <SelectValue placeholder="Pick a scene" />
          </SelectTrigger>
          <SelectContent>
            {overview.scenes.map((s) => (
              <SelectItem key={s.sceneId} value={s.sceneId}>
                Scene {s.ordinal}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" onClick={runScene} disabled={!scene || busy !== null}>
          {busy === 'scene' ? 'Huddling…' : 'Deliberate scene'}
        </Button>
        <Button size="sm" variant="secondary" onClick={runAll} disabled={overview.scenes.length === 0 || busy !== null}>
          {busy === 'all' ? 'Going scene by scene…' : 'Deliberate all scenes'}
        </Button>
      </div>

      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          The crew hasn&rsquo;t met about this film yet. Pick a scene and start a deliberation.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
          {ROLES.map((role) => {
            const persona = AGENT_PERSONAS[role];
            const mine = entries.filter((e) => e.author === role || e.to === role);
            const lessons = learnings?.[role] ?? [];
            return (
              <section key={role} className="flex flex-col overflow-hidden rounded-lg border">
                <header
                  className="flex items-baseline justify-between border-b-2 px-3 py-2"
                  style={{ borderBottomColor: persona.color }}
                >
                  <span className="text-sm font-semibold">{persona.role}</span>
                  <span className="text-xs text-muted-foreground">{persona.name}</span>
                </header>

                {lessons.length > 0 && (
                  <div className="border-b px-3 py-2">
                    <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Craft lessons</p>
                    <ul className="flex flex-col gap-1">
                      {lessons.slice(0, 5).map((l) => (
                        <li key={l.id} className="text-xs leading-snug">
                          {l.body}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <ul className="flex flex-col divide-y">
                  {mine.map((e) => (
                    <li key={e.id} className={cn('px-3 py-2 text-xs leading-snug', e.kind === 'reply' && 'pl-6')}>
                      <span className="text-muted-foreground">
                        Scene {ordinalOf(e.sceneId)}
                        {e.kind === 'ask' && e.to && ` · asks ${e.to}`}
                        {e.kind === 'reply' && ' · replies'}
                        {e.kind === 'think' && ' · thinking'}
                      </span>
                      <p className="mt-0.5">{e.body}</p>
                    </li>
                  ))}
                  {mine.length === 0 && <li className="px-3 py-2 text-xs text-muted-foreground">Nothing yet.</li>}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
