import { Nav } from '@/sections/Nav';
import { ScrollSequence } from '@/sections/ScrollSequence';
import { Explore } from '@/sections/Explore';
import { Footer } from '@/sections/Footer';

export function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Nav />
      <ScrollSequence />
      <Explore />
      <Footer />
    </div>
  );
}
