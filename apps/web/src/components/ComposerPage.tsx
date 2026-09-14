import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { ProjectOverview } from '@osai/core';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { PrimarySurface } from '@/components/ui/primary-surface';

/**
 * Sonic's workspace: the score's musical direction, decided from the Director's
 * style brief (MUSIC_NODE's one graph dependency — see `Project.seedMusicNode`).
 * Brief only, same as the Director/Writer/Cinematographer rounds — no real audio
 * generation exists anywhere in the app yet (music/speech are still fake-only,
 * see `apps/server/src/context.ts`), so this doesn't pretend to render a score.
 * Single-column on purpose — there's no secondary reference content worth a rail.
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
    <div className="mx-auto max-w-3xl">
      <PrimarySurface
        role="Composer"
        title="Musical direction"
        action={
          <Button disabled={busy || !overview.style.format} onClick={generate}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : hasDirection ? 'Regenerate direction' : 'Generate direction'}
          </Button>
        }
      >
        {!overview.style.format && (
          <p className="mb-4 text-sm text-muted-foreground">
            No style brief yet — set one on the Director page first, so the score has something to respond to.
          </p>
        )}

        {hasDirection && (
          <div className="grid grid-cols-2 gap-x-4 gap-y-4 text-sm sm:grid-cols-3">
            <div>
              <span className="text-xs text-muted-foreground">Genre</span>
              <p>{music.genre}</p>
            </div>
            <div>
              <span className="text-xs text-muted-foreground">Instrumentation</span>
              <p>{music.instrumentation}</p>
            </div>
            <div>
              <span className="text-xs text-muted-foreground">Tempo</span>
              <p>{music.tempo}</p>
            </div>
            <div>
              <span className="text-xs text-muted-foreground">Mood</span>
              <p>{music.mood}</p>
            </div>
            <div className="col-span-2 sm:col-span-3">
              <span className="text-xs text-muted-foreground">Direction</span>
              <p>{music.direction}</p>
            </div>
          </div>
        )}

        {overview.scenes.length > 0 && (
          <div className="mt-6 flex justify-end">
            <Button variant="ghost" size="sm" onClick={onContinue}>
              Continue to Editor →
            </Button>
          </div>
        )}
      </PrimarySurface>
    </div>
  );
}
