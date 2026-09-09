import { useState } from 'react';
import { motion } from 'framer-motion';
import { Loader2 } from 'lucide-react';
import { AGENT_PERSONAS, type ProjectOverview, type StylePayload } from '@osai/core';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { STATUS_LABEL, STATUS_TONE } from '@/components/SceneCard';
import { cn } from '@/lib/utils';

const persona = AGENT_PERSONAS.Director;

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
 * read-only scene breakdown. First of the five agent pages; Writer/
 * Cinematographer/Composer/Editor pages, and a handoff action between them,
 * come in later passes once each exists.
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
          <CardTitle className="text-sm">Creative Command</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Textarea
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            placeholder="One line is enough — a lighthouse keeper's last night on duty"
            rows={2}
          />
          <div>
            <Button size="sm" disabled={busy || !idea.trim()} onClick={generate}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : hasBrief ? 'Regenerate brief' : 'Generate brief'}
            </Button>
          </div>

          {hasBrief && (
            <div className="grid grid-cols-2 gap-3 rounded-lg border p-4 text-sm sm:grid-cols-3">
              {BRIEF_FIELDS.map(([label, key]) => {
                const value = style[key];
                if (!value) return null;
                return (
                  <div key={key}>
                    <span className="text-muted-foreground">{label}</span>
                    <p>{String(value)}</p>
                  </div>
                );
              })}
              {style.runtimeMinutes !== undefined && (
                <div>
                  <span className="text-muted-foreground">Runtime</span>
                  <p>{style.runtimeMinutes} min</p>
                </div>
              )}
              {style.characters && style.characters.length > 0 && (
                <div>
                  <span className="text-muted-foreground">Characters</span>
                  <p>{style.characters.join(', ')}</p>
                </div>
              )}
              {style.locations && style.locations.length > 0 && (
                <div>
                  <span className="text-muted-foreground">Locations</span>
                  <p>{style.locations.join(', ')}</p>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {hasBrief && (
        <div className="flex justify-end">
          <Button variant="secondary" size="sm" onClick={onContinue}>
            Continue to Writer →
          </Button>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Story &amp; Scene Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          {overview.scenes.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No scenes yet — finish the script to see the breakdown here.
            </p>
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
        </CardContent>
      </Card>
    </div>
  );
}
