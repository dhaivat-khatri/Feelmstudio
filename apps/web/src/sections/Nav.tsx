import { Menu } from 'lucide-react';
import { useEffect, useState } from 'react';
import { BrandLockup } from '@/components/Wordmark';
import { cn } from '@/lib/utils';

const LINKS = [
  { href: '/about', label: 'About' },
  { href: '/services', label: 'Services' },
  { href: '/portfolio', label: 'Portfolio' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/contact', label: 'Contact' },
] as const;

export function Nav() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 32);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header
      className={cn(
        'fixed inset-x-0 top-0 z-50 border-b text-white transition-colors duration-300',
        scrolled ? 'border-white/10 bg-[#100e0b]/80 backdrop-blur-xl' : 'border-transparent',
      )}
    >
      <div
        className={cn(
          'mx-auto flex max-w-6xl items-center justify-between px-5 transition-all duration-300 sm:px-8',
          scrolled ? 'h-14' : 'h-20',
        )}
      >
        <a href="/" className="flex items-center" aria-label="Feelm Studio — home">
          <BrandLockup markSize={20} tag={false} className="[&>svg]:text-brand-1" />
        </a>

        <nav className="hidden items-center gap-8 text-[13px] font-medium text-white/55 md:flex">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href} className="transition-colors hover:text-white">
              {l.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-3">
          <a
            href="/studio"
            className="hidden rounded-full bg-brand-1 px-4 py-1.5 text-[13px] font-semibold text-[#17100a] transition-colors hover:bg-brand-2 sm:inline-block"
          >
            Launch
          </a>
          <button onClick={() => setOpen((o) => !o)} aria-label="Menu" className="md:hidden">
            <Menu className="size-5" />
          </button>
        </div>
      </div>

      {open && (
        <nav className="flex flex-col gap-1 border-t border-white/10 bg-[#100e0b]/95 px-5 py-4 backdrop-blur-xl md:hidden">
          {LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className="py-2 text-sm font-medium text-white/65"
            >
              {l.label}
            </a>
          ))}
          <a
            href="/studio"
            className="mt-2 rounded-full bg-brand-1 px-4 py-2 text-center text-sm font-semibold text-[#17100a]"
          >
            Launch
          </a>
        </nav>
      )}
    </header>
  );
}
