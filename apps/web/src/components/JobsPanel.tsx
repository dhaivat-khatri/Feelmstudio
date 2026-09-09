import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { Job } from '@osai/jobs';

import { api } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';

const STATUS_VARIANT: Record<Job['status'], 'default' | 'secondary' | 'destructive' | 'outline'> = {
  queued: 'secondary',
  running: 'default',
  succeeded: 'outline',
  failed: 'destructive',
  cancelled: 'outline',
};

/** Deon's jobs-at-a-glance (F9), scoped to the open project — a live badge + a panel. */
export function JobsPanel({ projectId }: { projectId: string }) {
  const [jobs, setJobs] = useState<readonly Job[]>([]);

  useEffect(() => {
    const poll = () => api.listJobs(projectId).then(setJobs).catch(() => {});
    poll();
    const timer = setInterval(poll, 3000);
    return () => clearInterval(timer);
  }, [projectId]);

  const active = jobs.filter((j) => j.status === 'queued' || j.status === 'running').length;

  return (
    <Sheet>
      <SheetTrigger className={buttonVariants({ variant: 'outline', size: 'sm', className: 'gap-1.5' })}>
        {active > 0 && <Loader2 className="size-3.5 animate-spin" />}
        Jobs
        {active > 0 && <Badge variant="secondary" className="ml-0.5 px-1.5">{active}</Badge>}
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Jobs</SheetTitle>
        </SheetHeader>
        <ScrollArea className="h-[calc(100vh-6rem)] px-4">
          <div className="flex flex-col gap-2 pb-6">
            {jobs.length === 0 && <p className="text-sm text-muted-foreground">No jobs yet.</p>}
            {jobs
              .slice()
              .reverse()
              .map((job) => (
                <div key={job.id} className="rounded-md border p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{job.kind}</span>
                    <Badge variant={STATUS_VARIANT[job.status]}>{job.status}</Badge>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{job.nodeId}</p>
                  {job.error && <p className="mt-1 text-xs text-destructive">{job.error.message}</p>}
                </div>
              ))}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
