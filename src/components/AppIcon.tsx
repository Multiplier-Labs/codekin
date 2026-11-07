/**
 * The Codekin mark, drawn like the website's logo: rings in the current text
 * color (ink) and orbital dots in the brand orange — here the theme's
 * primary-5, which is the brand orange in Dark and each theme's own primary
 * elsewhere.
 */
export default function AppIcon({ size = 24, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* Center nucleus ring */}
      <path d="M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" />
      {/* Orbital arcs */}
      <path d="M8 20.1a9 9 0 0 1 -5 -7.1" />
      <path d="M16 20.1a9 9 0 0 0 5 -7.1" />
      <path d="M6.2 5a9 9 0 0 1 11.4 0" />
      {/* Orbital endpoint dots */}
      <g fill="var(--color-primary-5)" stroke="none">
        <circle cx="12" cy="21" r="1.2" />
        <circle cx="3" cy="9" r="1.2" />
        <circle cx="21" cy="9" r="1.2" />
      </g>
    </svg>
  )
}
