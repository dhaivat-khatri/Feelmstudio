import { Nav } from '@/sections/Nav';
import { ScrollSequence } from '@/sections/ScrollSequence';
import { Footer } from '@/sections/Footer';

export function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Nav />
      <ScrollSequence />
      <Footer />
    </div>
  );
}
