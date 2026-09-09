import type { SVGProps } from 'react';

/**
 * Feelm Studio mark — a camera aperture whose blades are broken fingerprint
 * ridges: three concentric rings of six arc segments, the gaps rotating ring to
 * ring so the breaks spiral like a real print, closing on a hex aperture at the
 * core. Human touch meeting a lens. Draws in `currentColor`.
 */
export function BrandMark({ size = 24, ...props }: { size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      aria-hidden="true"
      {...props}
    >
      <path
        strokeWidth={2.7}
        d="M44 24A20 20 0 0 1 39.54 36.59M34 41.32A20 20 0 0 1 20.87 43.75M14 41.32A20 20 0 0 1 5.33 31.17M4 24A20 20 0 0 1 8.46 11.41M14 6.68A20 20 0 0 1 27.13 4.25M34 6.68A20 20 0 0 1 42.67 16.83"
      />
      <path
        strokeWidth={2.3}
        d="M38.07 27.51A14.5 14.5 0 0 1 33.51 34.94M28 37.94A14.5 14.5 0 0 1 19.28 37.71M13.93 34.43A14.5 14.5 0 0 1 9.77 26.77M9.93 20.49A14.5 14.5 0 0 1 14.49 13.06M20 10.06A14.5 14.5 0 0 1 28.72 10.29M34.07 13.57A14.5 14.5 0 0 1 38.23 21.23"
      />
      <path
        strokeWidth={1.9}
        d="M31.95 28.23A9 9 0 0 1 28.77 31.63M24.31 32.99A9 9 0 0 1 19.77 31.95M16.37 28.77A9 9 0 0 1 15.01 24.31M16.05 19.77A9 9 0 0 1 19.23 16.37M23.69 15.01A9 9 0 0 1 28.23 16.05M31.63 19.23A9 9 0 0 1 32.99 23.69"
      />
      <path strokeWidth={1.7} strokeLinejoin="round" d="M27.12 22.2 27.12 25.8 24 27.6 20.88 25.8 20.88 22.2 24 20.4Z" />
    </svg>
  );
}
