import { CheckCheck } from 'lucide-react';
import { LIFECYCLES, type ProjectLifecycle } from '@osai/core';

import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { JobsPanel } from '@/components/JobsPanel';

export function TopBar({
  projectId,
  title,
  lifecycle,
  onLifecycleChange,
  onApproveAll,
}: {
  projectId: string;
  title: string;
  lifecycle: ProjectLifecycle;
  onLifecycleChange: (lifecycle: ProjectLifecycle) => void;
  onApproveAll: () => void;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b px-5">
      <h1 className="truncate text-sm font-semibold">{title}</h1>
      <div className="flex items-center gap-2">
        <JobsPanel projectId={projectId} />
        <Select value={lifecycle} onValueChange={(v) => onLifecycleChange(v as ProjectLifecycle)}>
          <SelectTrigger size="sm" className="w-28 capitalize">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LIFECYCLES.map((l) => (
              <SelectItem key={l} value={l} className="capitalize">
                {l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="secondary" className="gap-1.5" onClick={onApproveAll}>
          <CheckCheck className="size-4" />
          Approve all
        </Button>
      </div>
    </header>
  );
}
