import { AGENT_PERSONAS, type PersonaRole } from '@osai/core';

import { cn } from '@/lib/utils';

const ROLES: readonly PersonaRole[] = ['Director', 'Writer', 'Cinematographer', 'Composer', 'Editor'];

/**
 * The crew as a figure shelf, not a color-chip tab bar: each persona is
 * their own cutout character standing on a thin line, dimmed when idle and
 * lit up when their workspace is open.
 */
export function CrewRail({
  active,
  onSelect,
}: {
  active: PersonaRole | null;
  onSelect: (role: PersonaRole) => void;
}) {
  return (
    <div className="flex w-20 shrink-0 flex-col items-center gap-3 border-r bg-sidebar/40 py-4">
      {ROLES.map((role) => {
        const persona = AGENT_PERSONAS[role];
        const isActive = active === role;
        return (
          <button
            key={role}
            type="button"
            onClick={() => onSelect(role)}
            title={persona.name}
            className="relative flex h-14 w-full items-end justify-center"
          >
            <span
              className="absolute bottom-0 h-[3px] w-9 rounded-full transition-opacity"
              style={{ background: persona.color, opacity: isActive ? 0.6 : 0 }}
            />
            <img
              src={`/agents-cutout/${role.toLowerCase()}/f001.webp`}
              alt={persona.name}
              className={cn(
                'h-full w-auto object-contain transition-transform duration-200',
                isActive && '-translate-y-0.5 scale-105',
              )}
              style={{
                filter: isActive
                  ? 'drop-shadow(0 3px 5px rgba(0,0,0,0.5))'
                  : 'drop-shadow(0 3px 5px rgba(0,0,0,0.5)) grayscale(0.55) opacity(0.55)',
              }}
            />
          </button>
        );
      })}
    </div>
  );
}
