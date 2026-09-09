import { BrandLockup } from '@/components/Wordmark';

const LINKS = [
  { href: '/about', label: 'About' },
  { href: '/services', label: 'Services' },
  { href: '/portfolio', label: 'Portfolio' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/contact', label: 'Contact' },
] as const;

export function Footer() {
  return (
    <footer className="void-bg px-6 py-10 text-white">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 sm:flex-row">
        <a href="/" className="text-white/70" aria-label="Feelm Studio — home">
          <BrandLockup markSize={18} className="[&>svg]:text-brand-1" />
        </a>
        <nav className="flex flex-wrap items-center justify-center gap-5 text-sm text-white/60">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href} className="transition-colors hover:text-white">
              {l.label}
            </a>
          ))}
        </nav>
        <p className="text-xs text-white/40">© 2026 Feelm Studio. One idea in, a finished film out.</p>
      </div>
    </footer>
  );
}
