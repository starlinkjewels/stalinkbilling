/**
 * The Starlink Jewels mark — a brilliant-cut diamond outline with a sparkle
 * in its table, drawn in `currentColor` so it takes the colour of whatever
 * tile it sits in (the light `bg-primary-soft` chip in the sidebar, the
 * translucent white chip on the login/splash brand panel).
 *
 * Deliberately a stroked outline rather than a solid glyph: at the 16–22px
 * the shell actually renders it, a filled diamond reads as an anonymous blob,
 * while the outline keeps the gem's facets legible. Kept as a component (not
 * an <img> to the favicon) so it inherits colour and never costs a request.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true" focusable="false">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth={4}
        strokeLinejoin="round"
        d="M11 25 L20.5 13.5 H43.5 L53 25 L32 52 Z"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth={2.6}
        strokeLinejoin="round"
        opacity={0.65}
        d="M11 25 H53 M20.5 13.5 L25 25 L32 52 M43.5 13.5 L39 25"
      />
      <path
        fill="currentColor"
        d="M32 16.5c1.1 6.4 2.6 7.9 9 9-6.4 1.1-7.9 2.6-9 9-1.1-6.4-2.6-7.9-9-9 6.4-1.1 7.9-2.6 9-9Z"
      />
    </svg>
  );
}
