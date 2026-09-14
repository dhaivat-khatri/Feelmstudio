import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { ProjectOverview } from '@osai/core';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { PrimarySurface } from '@/components/ui/primary-surface';
import { Section } from '@/components/ui/section';
import { ScriptForm } from '@/components/ScriptEditor';

/**
 * Lyra's workspace: draft the script from the Director's brief (no idea input here —
 * it reads `overview.idea`, already persisted by the Director page), then hand off to
 * the same edit/save/diff-review flow `ScriptEditor`'s dialog uses (`ScriptForm`), just
 * embedded on a page instead of behind a modal. The Director's brief sits as reference
 * in the side rail, since it's exactly what a script draft should be responding to.
 */
export function WriterPage({
  projectId,
  overview,
  onChanged,
  onContinue,
}: {
  projectId: string;
  overview: ProjectOverview;
  onChanged: () => void;
  /** Hands off to the Cinematographer page once scenes exist. */
  onContinue: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const { style } = overview;

  const generate = async () => {
    setBusy(true);
    try {
      const result = await api.generateScript(projectId, overview.idea);
      setDraft(result.script);
    } catch (e) {
      toast.error('Could not draft the script', { description: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[1fr_320px]">
      <PrimarySurface
        role="Writer"
        title="Draft the script"
        action={
          <Button disabled={busy || !overview.idea} onClick={generate}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : 'Generate script'}
          </Button>
        }
      >
        {!overview.idea && (
          <p className="mb-3 text-sm text-muted-foreground">
            No idea on file yet — set one on the Director page first, or paste a script directly below.
          </p>
        )}
        <ScriptForm key={draft ?? 'blank'} projectId={projectId} initialScript={draft} onDone={onChanged} />

        {overview.scenes.length > 0 && (
          <div className="mt-6 flex justify-end">
            <Button variant="ghost" size="sm" onClick={onContinue}>
              Continue to Cinematographer →
            </Button>
          </div>
        )}
      </PrimarySurface>

      {style.format && (
        <Section title="Responding to">
          <dl className="flex flex-col gap-3 text-sm">
            {style.tone && (
              <div>
                <dt className="text-xs text-muted-foreground">Tone</dt>
                <dd>{style.tone}</dd>
              </div>
            )}
            {style.genre && (
              <div>
                <dt className="text-xs text-muted-foreground">Genre</dt>
                <dd>{style.genre}</dd>
              </div>
            )}
            {style.mood && (
              <div>
                <dt className="text-xs text-muted-foreground">Mood</dt>
                <dd>{style.mood}</dd>
              </div>
            )}
            {style.characters && style.characters.length > 0 && (
              <div>
                <dt className="text-xs text-muted-foreground">Characters</dt>
                <dd>{style.characters.join(', ')}</dd>
              </div>
            )}
          </dl>
        </Section>
      )}
    </div>
  );
}
