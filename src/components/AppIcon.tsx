export default function AppIcon({ size = 24, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {/* Center nucleus ring */}
      <circle cx="12" cy="12" r="2.5" />
      {/* Inner filled core */}
      <circle cx="12" cy="12" r="0.75" fill="currentColor" stroke="none" />
      {/* Orbital arcs */}
      <path d="M8 20.1a9 9 0 0 1 -5 -7.1" />
      <path d="M16 20.1a9 9 0 0 0 5 -7.1" />
      <path d="M6.2 5a9 9 0 0 1 11.4 0" />
      {/* Orbital endpoint dots */}
      <circle cx="12" cy="21" r="1" fill="currentColor" stroke="none" />
      <circle cx="3" cy="9" r="1" fill="currentColor" stroke="none" />
      <circle cx="21" cy="9" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}
