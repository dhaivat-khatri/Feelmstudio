import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { ProjectOverview, StylePayload } from '@osai/core';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { PrimarySurface } from '@/components/ui/primary-surface';
import { Section } from '@/components/ui/section';
import { Badge } from '@/components/ui/badge';
import { STATUS_LABEL, STATUS_TONE } from '@/components/SceneCard';
import { cn } from '@/lib/utils';

const BRIEF_FIELDS: readonly [label: string, key: keyof StylePayload][] = [
  ['Tone', 'tone'],
  ['Palette', 'palette'],
  ['Pacing', 'pacing'],
  ['Mood', 'mood'],
  ['Format', 'format'],
  ['Genre', 'genre'],
];

/**
 * Ezra's workspace: the creative brief (idea in, style brief out — same agent
 * call the setup wizard uses, but durable and revisitable afterward) plus a
 * read-only scene breakdown, laid out as a work surface (left) with the
 * resulting brief and scene status as reference in the side rail (right).
 */
export function DirectorPage({
  projectId,
  overview,
  onChanged,
  onContinue,
}: {
  projectId: string;
  overview: ProjectOverview;
  onChanged: () => void;
  /** Hands off to the Writer page once a brief exists. */
  onContinue: () => void;
}) {
  const [idea, setIdea] = useState(overview.idea);
  const [busy, setBusy] = useState(false);
  const { style } = overview;
  const hasBrief = style.format !== undefined;

  const generate = async () => {
    if (!idea.trim()) return;
    setBusy(true);
    try {
      await api.generateStyle(projectId, idea.trim());
      onChanged();
      toast.success('Brief updated');
    } catch (e) {
      toast.error('Could not generate direction', { description: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[1fr_320px]">
      <PrimarySurface
        role="Director"
        title="Creative command"
        action={
          <Button disabled={busy || !idea.trim()} onClick={generate}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : hasBrief ? 'Regenerate brief' : 'Generate brief'}
          </Button>
        }
      >
        <Textarea
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          placeholder="One line is enough — a lighthouse keeper's last night on duty"
          rows={4}
          className="text-base"
        />
        {hasBrief && (
          <div className="mt-6 flex justify-end">
            <Button variant="ghost" size="sm" onClick={onContinue}>
              Continue to Writer →
            </Button>
          </div>
        )}
      </PrimarySurface>

      <div className="flex flex-col gap-6">
        {hasBrief && (
          <Section title="The brief">
            <dl className="flex flex-col gap-3 text-sm">
              {BRIEF_FIELDS.map(([label, key]) => {
                const value = style[key];
                if (!value) return null;
                return (
                  <div key={key}>
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd>{String(value)}</dd>
                  </div>
                );
              })}
              {style.runtimeMinutes !== undefined && (
                <div>
                  <dt className="text-xs text-muted-foreground">Runtime</dt>
                  <dd>{style.runtimeMinutes} min</dd>
                </div>
              )}
              {style.characters && style.characters.length > 0 && (
                <div>
                  <dt className="text-xs text-muted-foreground">Characters</dt>
                  <dd>{style.characters.join(', ')}</dd>
                </div>
              )}
              {style.locations && style.locations.length > 0 && (
                <div>
                  <dt className="text-xs text-muted-foreground">Locations</dt>
                  <dd>{style.locations.join(', ')}</dd>
                </div>
              )}
            </dl>
          </Section>
        )}

        <Section title="Scene breakdown">
          {overview.scenes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No scenes yet — finish the script to see the breakdown here.</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {overview.scenes.map((scene) => (
                <li key={scene.sceneId} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="truncate">
                    Scene {scene.ordinal}
                    {scene.heading ? ` — ${scene.heading}` : ''}
                  </span>
                  <Badge className={cn('shrink-0', STATUS_TONE[scene.status] ?? STATUS_TONE.notStarted)}>
                    {STATUS_LABEL[scene.status] ?? scene.status}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}
