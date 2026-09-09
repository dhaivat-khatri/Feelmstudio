import { useState } from 'react';
import { motion } from 'framer-motion';
import { Loader2 } from 'lucide-react';
import { AGENT_PERSONAS, type ProjectOverview } from '@osai/core';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScriptForm } from '@/components/ScriptEditor';

const persona = AGENT_PERSONAS.Writer;

/**
 * Lyra's workspace: draft the script from the Director's brief (no idea input here —
 * it reads `overview.idea`, already persisted by the Director page), then hand off to
 * the same edit/save/diff-review flow `ScriptEditor`'s dialog uses (`ScriptForm`), just
 * embedded on a page instead of behind a modal.
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
          <CardTitle className="text-sm">Draft from the brief</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {!overview.idea && (
            <p className="text-sm text-muted-foreground">
              No idea on file yet — set one on the Director page first, or paste a script directly below.
            </p>
          )}
          <div>
            <Button size="sm" disabled={busy || !overview.idea} onClick={generate}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : 'Generate script'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <ScriptForm key={draft ?? 'blank'} projectId={projectId} initialScript={draft} onDone={onChanged} />
        </CardContent>
      </Card>

      {overview.scenes.length > 0 && (
        <div className="flex justify-end">
          <Button variant="secondary" size="sm" onClick={onContinue}>
            Continue to Cinematographer →
          </Button>
        </div>
      )}
    </div>
  );
}
