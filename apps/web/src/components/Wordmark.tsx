import { cn } from '@/lib/utils';
import { BrandMark } from '@/components/BrandMark';

/**
 * The "feelm / STUDIO" lockup. `Wordmark` is the type only; `BrandLockup` pairs
 * it with the aperture mark for headers and the sidebar.
 */
export function Wordmark({ className, tag = true }: { className?: string; tag?: boolean }) {
  return (
    <span className={cn('inline-flex flex-col leading-none', className)}>
      <span className="wordmark text-[1.15em] lowercase">feelm</span>
      {tag && (
        <span className="mt-[0.3em] text-[0.4em] font-medium uppercase tracking-[0.34em] opacity-60">
          Studio
        </span>
      )}
    </span>
  );
}

export function BrandLockup({
  className,
  markSize = 22,
  tag = true,
}: {
  className?: string;
  markSize?: number;
  tag?: boolean;
}) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <BrandMark size={markSize} className="shrink-0" />
      <Wordmark tag={tag} className="text-[0.92rem]" />
    </span>
  );
}
