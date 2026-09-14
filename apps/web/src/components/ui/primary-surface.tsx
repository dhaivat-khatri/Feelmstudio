import type { ReactNode } from 'react';
import { AGENT_PERSONAS, type PersonaRole } from '@osai/core';

import { cn } from '@/lib/utils';

/**
 * The one real workspace surface per agent page — a big serif headline and
 * a persona-colored top edge instead of a small gray CardTitle, so the page
 * has an actual focal point instead of reading as a stack of identical
 * shadcn cards.
 */
export function PrimarySurface({
  role,
  title,
  action,
  children,
  className,
}: {
  role: PersonaRole;
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const persona = AGENT_PERSONAS[role];
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-2xl bg-card p-6 shadow-[0_28px_70px_-38px_rgba(0,0,0,0.6)] sm:p-8',
        className,
      )}
    >
      <div className="absolute inset-x-0 top-0 h-1" style={{ background: persona.color }} />
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-heading text-2xl leading-tight font-medium">{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}
