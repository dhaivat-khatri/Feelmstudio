import type { ComponentType } from 'react';
import { Nav } from '@/sections/Nav';
import { Footer } from '@/sections/Footer';

/** Shell for the standalone About/Services/Portfolio/Pricing/Contact pages. */
export function SectionPage({ Section }: { Section: ComponentType }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Nav />
      <Section />
      <Footer />
    </div>
  );
}
