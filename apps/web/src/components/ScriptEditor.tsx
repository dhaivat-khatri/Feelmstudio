import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import type { SegmentationDiff } from '@osai/core';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

function splitScript(script: string) {
  return script
    .split(/\n\s*\n/)
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text) => ({ text }));
}

function truncate(text: string, n = 140) {
  return text.length > n ? `${text.slice(0, n).trimEnd()}…` : text;
}

/**
 * The highest-stakes screen in the edit path: a re-segmentation is a proposal over
 * the user's own text, never applied silently. Every bucket below maps to a
 * SegmentationDiff field one-to-one, so what's shown is exactly what `applySegmentation`
 * is about to commit — no aggregate count hides a change the user didn't see coming.
 */
function SegmentationReview({
  diff,
  oldTexts,
  busy,
  onApply,
  onCancel,
}: {
  diff: SegmentationDiff;
  oldTexts: ReadonlyMap<string, string>;
  busy: boolean;
  onApply: () => void;
  onCancel: () => void;
}) {
  const newTextAt = (ordinal: number) => diff.next.find((s) => s.ordinal === ordinal)?.text ?? '';
  const newTextById = (id: string) => diff.next.find((s) => s.id === id)?.text ?? '';
  const rewritten = diff.matched.filter((m) => m.positional);
  const edited = diff.matched.filter((m) => m.textChanged && !m.positional);

  return (
    <div className="flex flex-col gap-4">
      <div
        className={cn(
          'rounded-lg border p-3 text-sm',
          diff.requiresReview
            ? 'border-status-attention/40 bg-status-attention/10'
            : 'border-status-approved/40 bg-status-approved/10',
        )}
      >
        <p className="font-medium capitalize">{diff.summary}</p>
        {diff.requiresReview && (
          <p className="mt-1 text-muted-foreground">
            This re-segmentation changes scene identity — review each change below before applying.
          </p>
        )}
      </div>

      <div className="flex max-h-96 flex-col gap-4 overflow-y-auto pr-1">
        {rewritten.length > 0 && (
          <section>
            <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-status-attention">
              Rewritten in place — confirm this is the same scene ({rewritten.length})
            </h4>
            <ul className="flex flex-col gap-2">
              {rewritten.map((m) => (
                <li key={m.sceneId} className="rounded-md border p-2 text-xs">
                  <p className="text-muted-foreground line-through">
                    {truncate(oldTexts.get(m.sceneId) ?? '(original text unavailable)')}
                  </p>
                  <p className="mt-1">{truncate(newTextAt(m.toOrdinal))}</p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {edited.length > 0 && (
          <section>
            <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Edited ({edited.length})
            </h4>
            <ul className="flex flex-col gap-2">
              {edited.map((m) => (
                <li key={m.sceneId} className="rounded-md border p-2 text-xs">
                  <p className="text-muted-foreground line-through">{truncate(oldTexts.get(m.sceneId) ?? '')}</p>
                  <p className="mt-1">{truncate(newTextAt(m.toOrdinal))}</p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {diff.splits.length > 0 && (
          <section>
            <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-status-attention">
              Split ({diff.splits.length})
            </h4>
            <ul className="flex flex-col gap-2">
              {diff.splits.map((s) => (
                <li key={s.from} className="rounded-md border p-2 text-xs">
                  <p className="text-muted-foreground line-through">{truncate(oldTexts.get(s.from) ?? '')}</p>
                  <p className="mt-1.5 font-medium">became {s.into.length} scenes:</p>
                  <ul className="mt-1 list-disc pl-4">
                    {s.into.map((id) => (
                      <li key={id} className={id === s.inherited ? 'font-medium' : undefined}>
                        {truncate(newTextById(id), 100)}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </section>
        )}

        {diff.merges.length > 0 && (
          <section>
            <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-status-attention">
              Merged ({diff.merges.length})
            </h4>
            <ul className="flex flex-col gap-2">
              {diff.merges.map((m) => (
                <li key={m.into} className="rounded-md border p-2 text-xs">
                  <p className="font-medium">{m.from.length} scenes merged into one:</p>
                  <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                    {m.from.map((id) => (
                      <li key={id} className="line-through">
                        {truncate(oldTexts.get(id) ?? '', 100)}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1.5">{truncate(newTextById(m.into))}</p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {diff.restructured.length > 0 && (
          <section>
            <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-status-attention">
              Restructured ({diff.restructured.length})
            </h4>
            <ul className="flex flex-col gap-2">
              {diff.restructured.map((r, i) => (
                // eslint-disable-next-line react/no-array-index-key
                <li key={i} className="rounded-md border p-2 text-xs">
                  {r.from.length} scenes reshuffled into {r.into.length} scenes — no clean 1:1 match, check the
                  new boundaries carefully.
                </li>
              ))}
            </ul>
          </section>
        )}

        {(diff.added.length > 0 || diff.removed.length > 0) && (
          <section className="grid grid-cols-2 gap-3">
            {diff.added.length > 0 && (
              <div>
                <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-status-approved">
                  Added ({diff.added.length})
                </h4>
                <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                  {diff.added.map((id) => (
                    <li key={id}>{truncate(newTextById(id), 80)}</li>
                  ))}
                </ul>
              </div>
            )}
            {diff.removed.length > 0 && (
              <div>
                <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-status-failed">
                  Removed ({diff.removed.length})
                </h4>
                <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                  {diff.removed.map((id) => (
                    <li key={id} className="line-through">
                      {truncate(oldTexts.get(id) ?? '', 80)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}
      </div>

      <div className="flex gap-2">
        <Button variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={busy} onClick={onApply}>
          Apply re-segmentation
        </Button>
      </div>
    </div>
  );
}

export function ScriptForm({
  projectId,
  initialScript,
  onDone,
}: {
  projectId: string;
  /** Prefills the textarea — e.g. a freshly AI-drafted script the Writer page just generated. */
  initialScript?: string;
  onDone: () => void;
}) {
  const [script, setScript] = useState(initialScript ?? '');
  const [diff, setDiff] = useState<SegmentationDiff | null>(null);
  const [oldTexts, setOldTexts] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState(false);

  // Fetched silently on mount (independent of the "Load current script" button below)
  // so the review panel always has "before" text to diff against, even if the user
  // pastes a brand-new script over the textarea instead of loading the old one first.
  useEffect(() => {
    api
      .getProject(projectId)
      .then(async (overview) => {
        const scenes = await Promise.all(overview.scenes.map((s) => api.getScene(projectId, s.sceneId)));
        setOldTexts(new Map(scenes.map((s) => [s.sceneId, String(s.parts.text.payload ?? '')])));
      })
      .catch(() => {});
  }, [projectId]);

  const loadCurrent = async () => {
    const overview = await api.getProject(projectId);
    const scenes = await Promise.all(overview.scenes.map((s) => api.getScene(projectId, s.sceneId)));
    setScript(scenes.map((s) => String(s.parts.text.payload ?? '')).join('\n\n'));
  };

  const save = async () => {
    const segments = splitScript(script);
    if (segments.length === 0) return;
    setBusy(true);
    try {
      const result = await api.saveScript(projectId, segments);
      if (result.applied) {
        toast.success('Scenes created');
        onDone();
      } else if (result.diff) {
        setDiff(result.diff);
      }
    } catch (e) {
      toast.error('Could not save script', { description: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const applyDiff = async () => {
    if (!diff) return;
    setBusy(true);
    try {
      await api.applySegmentation(projectId, diff);
      setDiff(null);
      toast.success('Re-segmentation applied');
      onDone();
    } catch (e) {
      toast.error('Could not apply segmentation', { description: String(e) });
    } finally {
      setBusy(false);
    }
  };

  if (diff) {
    return (
      <SegmentationReview
        diff={diff}
        oldTexts={oldTexts}
        busy={busy}
        onApply={applyDiff}
        onCancel={() => setDiff(null)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-muted-foreground">Script</span>
        <Button variant="link" size="sm" className="h-auto p-0" onClick={loadCurrent}>
          Load current script
        </Button>
      </div>
      <Textarea
        value={script}
        onChange={(e) => setScript(e.target.value)}
        placeholder="Paste your script here — separate scenes with a blank line."
        rows={10}
      />
      <Button onClick={save} disabled={busy || !script.trim()} className="self-start">
        Save script
      </Button>
    </div>
  );
}

/** Always the dialog form — only ever mounted once a project already has scenes; the
 * empty (no scenes yet) case is now owned by ProjectWizard. */
export function ScriptEditor({ projectId, onSaved }: { projectId: string; onSaved: () => void }) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className={buttonVariants({ variant: 'outline', size: 'sm', className: 'gap-1.5' })}>
        <FileText className="size-4" />
        Edit script
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Script</DialogTitle>
        </DialogHeader>
        <ScriptForm
          projectId={projectId}
          onDone={() => {
            setOpen(false);
            onSaved();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
