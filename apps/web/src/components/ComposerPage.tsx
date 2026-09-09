import { useState } from 'react';
import { motion } from 'framer-motion';
import { Loader2 } from 'lucide-react';
import { AGENT_PERSONAS, type ProjectOverview } from '@osai/core';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const persona = AGENT_PERSONAS.Composer;

/**
 * Sonic's workspace: the score's musical direction, decided from the Director's
 * style brief (MUSIC_NODE's one graph dependency — see `Project.seedMusicNode`).
 * Brief only, same as the Director/Writer/Cinematographer rounds — no real audio
 * generation exists anywhere in the app yet (music/speech are still fake-only,
 * see `apps/server/src/context.ts`), so this doesn't pretend to render a score.
 */
export function ComposerPage({
  projectId,
  overview,
  onChanged,
  onContinue,
}: {
  projectId: string;
  overview: ProjectOverview;
  onChanged: () => void;
  /** Hands off to the Editor page. */
  onContinue: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const { music } = overview;
  const hasDirection = music.direction !== undefined;

  const generate = async () => {
    setBusy(true);
    try {
      await api.generateMusic(projectId);
      onChanged();
      toast.success('Music direction updated');
    } catch (e) {
      toast.error('Could not generate music direction', { description: String(e) });
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
          <CardTitle className="text-sm">Musical Direction</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {!overview.style.format && (
            <p className="text-sm text-muted-foreground">
              No style brief yet — set one on the Director page first, so the score has something to respond to.
            </p>
          )}
          <div>
            <Button size="sm" disabled={busy || !overview.style.format} onClick={generate}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : hasDirection ? 'Regenerate direction' : 'Generate direction'}
            </Button>
          </div>

          {hasDirection && (
            <div className="grid grid-cols-2 gap-3 rounded-lg border p-4 text-sm sm:grid-cols-3">
              <div>
                <span className="text-muted-foreground">Genre</span>
                <p>{music.genre}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Instrumentation</span>
                <p>{music.instrumentation}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Tempo</span>
                <p>{music.tempo}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Mood</span>
                <p>{music.mood}</p>
              </div>
              <div className="col-span-2 sm:col-span-3">
                <span className="text-muted-foreground">Direction</span>
                <p>{music.direction}</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {overview.scenes.length > 0 && (
        <div className="flex justify-end">
          <Button variant="secondary" size="sm" onClick={onContinue}>
            Continue to Editor →
          </Button>
        </div>
      )}
    </div>
  );
}
