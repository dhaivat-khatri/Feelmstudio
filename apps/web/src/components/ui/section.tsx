import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * Plain, unboxed content grouping — a label plus whitespace, not another
 * bordered card. Each agent page keeps exactly one real `Card` (the thing
 * you actually came to do); everything else uses this instead, so the page
 * has one clear focal surface rather than a stack of identically-weighted
 * boxes.
 */
export function Section({
  title,
  action,
  children,
  className,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}
