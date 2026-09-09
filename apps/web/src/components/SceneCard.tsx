import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { ImageOff, TriangleAlert } from 'lucide-react';
import type { NodeFailure, SceneSummary } from '@osai/core';

import { api } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export const STATUS_TONE: Record<string, string> = {
  notStarted: 'bg-muted text-muted-foreground',
  queued: 'bg-status-queued/15 text-status-queued',
  generating: 'bg-status-queued/15 text-status-queued',
  needsReview: 'bg-status-attention/15 text-status-attention',
  approved: 'bg-status-approved/15 text-status-approved',
  failed: 'bg-status-failed/15 text-status-failed',
};

export const STATUS_LABEL: Record<string, string> = {
  notStarted: 'Not started',
  queued: 'Queued',
  generating: 'Generating…',
  needsReview: 'Needs review',
  approved: 'Approved',
  failed: 'Failed',
};

const STALENESS_TONE: Record<string, string> = {
  outOfDate: 'bg-status-attention/15 text-status-attention',
  needsReview: 'bg-status-failed/15 text-status-failed',
};

const STALENESS_LABEL: Record<string, string> = {
  outOfDate: 'Out of date',
  needsReview: 'Structure changed',
};

export function SceneCard({
  projectId,
  scene,
  refreshToken,
  onOpen,
}: {
  projectId: string;
  scene: SceneSummary;
  refreshToken: number;
  onOpen: () => void;
}) {
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [isVideo, setIsVideo] = useState(false);
  const [failure, setFailure] = useState<NodeFailure | null>(null);

  useEffect(() => {
    api.getScene(projectId, scene.sceneId).then((d) => {
      const video = d.parts.video.mediaUrl;
      const image = d.parts.image.mediaUrl;
      setMediaUrl(video ?? image ?? null);
      setIsVideo(Boolean(video));
      setFailure(Object.values(d.parts).find((p) => p.failure)?.failure ?? null);
    }).catch(() => {});
  }, [projectId, scene.sceneId, refreshToken]);

  return (
    <motion.button
      onClick={onOpen}
      whileHover={{ y: -2 }}
      transition={{ duration: 0.15 }}
      className="group flex flex-col overflow-hidden rounded-lg border bg-card text-left"
    >
      <div className="relative aspect-video w-full overflow-hidden bg-muted">
        {mediaUrl ? (
          isVideo ? (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <video src={mediaUrl} muted loop playsInline className="h-full w-full object-cover" />
          ) : (
            <img src={mediaUrl} alt="" className="h-full w-full object-cover" />
          )
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground/50">
            <ImageOff className="size-6" />
          </div>
        )}
        <Badge className={cn('absolute right-2 top-2', STATUS_TONE[scene.status] ?? STATUS_TONE.notStarted)}>
          {STATUS_LABEL[scene.status] ?? scene.status}
        </Badge>
      </div>

      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="truncate text-sm font-medium">
          Scene {scene.ordinal}
          {scene.heading ? ` — ${scene.heading}` : ''}
        </span>
        {scene.staleness && (
          <Badge className={cn('shrink-0', STALENESS_TONE[scene.staleness] ?? STALENESS_TONE.outOfDate)}>
            {STALENESS_LABEL[scene.staleness] ?? scene.staleness}
          </Badge>
        )}
      </div>

      {scene.status === 'failed' && failure && (
        <div className="flex items-start gap-1.5 border-t border-status-failed/20 bg-status-failed/5 px-3 py-2 text-xs text-status-failed">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="line-clamp-2">{failure.message}</span>
        </div>
      )}
    </motion.button>
  );
}
