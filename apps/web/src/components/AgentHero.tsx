import { AGENT_PERSONAS, type PersonaRole } from '@osai/core';

import { AgentFigure } from '@/components/AgentFigure';

/**
 * The banner above an agent's workspace: name, tagline, and their live
 * cutout figure reacting to the cursor. Replaces the identical
 * avatar-circle-plus-name block every agent page used to render on its own.
 */
export function AgentHero({ role }: { role: PersonaRole }) {
  const persona = AGENT_PERSONAS[role];
  return (
    <div className="studio-bg relative mb-5 h-64 overflow-hidden rounded-xl border">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: `radial-gradient(ellipse 70% 60% at 65% 25%, color-mix(in oklch, ${persona.color}, transparent 85%), transparent 65%)`,
        }}
      />
      <div className="pointer-events-none absolute bottom-4 left-5 z-20">
        <p className="text-lg font-semibold">
          {persona.name} · {persona.role}
        </p>
        <p className="text-xs text-muted-foreground">{persona.tagline}</p>
      </div>
      <AgentFigure role={role} className="absolute inset-0 z-10" />
    </div>
  );
}
