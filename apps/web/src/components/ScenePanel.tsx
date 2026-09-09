import { useEffect, useState } from 'react';
import { Dices } from 'lucide-react';
import type { SceneSummary } from '@osai/core';
import { toast } from 'sonner';

import { api, type SceneDetail } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';

const randomSeed = () => Math.floor(Math.random() * 2 ** 31);

type GeneratablePart = 'image' | 'video' | 'narration';
const PARTS: readonly { key: GeneratablePart; label: string; hint: string }[] = [
  { key: 'image', label: 'Image', hint: 'image prompt' },
  { key: 'video', label: 'Video', hint: 'motion & action — e.g. slow push-in as she turns to the window, steam rising' },
  { key: 'narration', label: 'Narration', hint: 'narration prompt' },
];

export function ScenePanel({
  projectId,
  scene,
  onOpenChange,
  onChanged,
}: {
  projectId: string;
  scene: SceneSummary | null;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<SceneDetail | null>(null);
  const [prompts, setPrompts] = useState<Record<GeneratablePart, string>>({ image: '', video: '', narration: '' });
  const [busy, setBusy] = useState<Partial<Record<GeneratablePart, boolean>>>({});
  const [pending, setPending] = useState<Partial<Record<GeneratablePart, string>>>({});
  const [planBusy, setPlanBusy] = useState(false);

  useEffect(() => {
    if (!scene) return;
    setDetail(null);
    setPrompts({ image: '', video: '', narration: '' });
    setPending({});
    api.getScene(projectId, scene.sceneId).then((d) => {
      setDetail(d);
      const text = String(d.parts.text.payload ?? '').trim();
      if (text) setPrompts((p) => ({ ...p, image: p.image || text, narration: p.narration || text }));
    }).catch((e: unknown) => toast.error('Could not load scene', { description: String(e) }));
  }, [scene, projectId]);

  useEffect(() => {
    const activeParts = Object.entries(pending).filter(([, id]) => id);
    if (activeParts.length === 0 || !scene) return;

    const timer = setInterval(async () => {
      const jobs = await api.listJobs(projectId);
      let anyDone = false;
      for (const [part, jobId] of activeParts) {
        const job = jobs.find((j) => j.id === jobId);
        if (job && job.status !== 'queued' && job.status !== 'running') {
          anyDone = true;
          if (job.status === 'failed') {
            toast.error(`${part} generation failed`, { description: job.error?.message });
          } else if (job.status === 'succeeded') {
            toast.success(`${part} generated`);
          }
          setPending((prev) => {
            const next = { ...prev };
            delete next[part as GeneratablePart];
            return next;
          });
        }
      }
      if (anyDone && scene) {
        api.getScene(projectId, scene.sceneId).then(setDetail);
        onChanged();
      }
    }, 2000);

    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, projectId, scene]);

  if (!scene) return null;

  const imageReady = Boolean(detail?.parts.image.mediaUrl);

  // Reroll = same prompt, a fresh random seed, one click, no dialog. Re-prompt is just
  // this same function called after the user edited the Input above — they are
  // deliberately the same action with a different seed, not two separate code paths,
  // so a reroll can never drift from what re-prompting would otherwise send.
  const generate = async (part: GeneratablePart, options?: { reroll?: boolean }) => {
    setBusy((b) => ({ ...b, [part]: true }));
    try {
      const prompt = prompts[part].trim() || scene.heading || `Scene ${scene.ordinal}`;
      const seed = options?.reroll ? randomSeed() : undefined;
      const job = await api.generate(projectId, scene.sceneId, part, prompt, seed);
      setPending((p) => ({ ...p, [part]: job.id }));
    } catch (e) {
      toast.error(`Could not start ${part} generation`, { description: String(e) });
    } finally {
      setBusy((b) => ({ ...b, [part]: false }));
    }
  };

  const generatePlan = async () => {
    setPlanBusy(true);
    try {
      await api.generatePlan(projectId, scene.sceneId);
      toast.success('Plan generated');
      await api.getScene(projectId, scene.sceneId).then(setDetail);
      onChanged();
    } catch (e) {
      toast.error('Could not generate plan', { description: String(e) });
    } finally {
      setPlanBusy(false);
    }
  };

  const acknowledge = async () => {
    await api.acknowledgeScene(projectId, scene.sceneId);
    api.getScene(projectId, scene.sceneId).then(setDetail);
    onChanged();
  };

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            Scene {scene.ordinal}
            {scene.staleness && <Badge variant="outline" className="border-status-attention text-status-attention">{scene.staleness}</Badge>}
          </SheetTitle>
        </SheetHeader>

        <div className="flex flex-col gap-5 px-4 pb-6">
          {scene.needsAttention && (
            <Button size="sm" variant="outline" onClick={acknowledge}>
              Approve as-is
            </Button>
          )}

          {!detail ? (
            <Skeleton className="aspect-video w-full rounded-lg" />
          ) : (
            <div className="flex flex-col gap-3">
              {detail.parts.image.mediaUrl && (
                <img src={detail.parts.image.mediaUrl} alt="" className="w-full rounded-lg" />
              )}
              {detail.parts.video.mediaUrl && (
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <video src={detail.parts.video.mediaUrl} controls className="w-full rounded-lg" />
              )}
              {!detail.parts.image.mediaUrl && !detail.parts.video.mediaUrl && (
                <div className="flex aspect-video w-full items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">
                  Nothing generated yet
                </div>
              )}
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">Plan (Cinematographer)</span>
              <Button size="sm" variant="outline" disabled={planBusy} onClick={generatePlan}>
                {planBusy ? 'Generating…' : 'Generate'}
              </Button>
            </div>
            {(() => {
              const plan = detail?.parts.plan.payload as
                | { shotType?: string; framing?: string; cameraMove?: string }
                | undefined;
              const parts = [plan?.shotType, plan?.framing, plan?.cameraMove].filter(Boolean);
              return (
                <p className="text-xs text-muted-foreground">
                  {parts.length > 0 ? parts.join(' · ') : 'Not planned yet — uses the scene text as-is.'}
                </p>
              );
            })()}
          </div>

          {PARTS.map(({ key, label, hint }) => {
            const hasVersion = Boolean(detail?.parts[key].payload);
            const disabled = busy[key] || Boolean(pending[key]) || (key === 'video' && !imageReady);
            return (
              <div key={key} className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">{label}</span>
                <div className="flex items-center gap-2">
                  <Input
                    value={prompts[key]}
                    onChange={(e) => setPrompts((p) => ({ ...p, [key]: e.target.value }))}
                    placeholder={hint}
                    disabled={key === 'video' && !imageReady}
                    className="h-8 text-xs"
                  />
                  {hasVersion && (
                    <Button
                      size="icon-sm"
                      variant="outline"
                      onClick={() => generate(key, { reroll: true })}
                      disabled={disabled}
                      title="Reroll — same prompt, a different result"
                    >
                      <Dices className="size-3.5" />
                    </Button>
                  )}
                  <Button
                    size="sm"
                    onClick={() => generate(key)}
                    disabled={disabled}
                    title={
                      key === 'video' && !imageReady
                        ? 'Generate the scene image first'
                        : hasVersion
                          ? 'Regenerate with the prompt above'
                          : undefined
                    }
                  >
                    {pending[key] ? 'Generating…' : hasVersion ? 'Re-prompt' : 'Generate'}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
