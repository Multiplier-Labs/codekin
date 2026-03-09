import { useState, useRef, useEffect, useCallback } from 'react'

interface TimePickerProps {
  hour: number
  minute: number
  onChange: (hour: number, minute: number) => void
  step?: number // minute step, default 15
  className?: string
}

const HOURS = Array.from({ length: 24 }, (_, i) => i)

export default function TimePicker({ hour, minute, onChange, step = 15, className = '' }: TimePickerProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const hourListRef = useRef<HTMLDivElement>(null)
  const minListRef = useRef<HTMLDivElement>(null)

  const minutes = Array.from({ length: 60 / step }, (_, i) => i * step)

  const pad = (n: number) => String(n).padStart(2, '0')

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Scroll selected items into view when opening
  useEffect(() => {
    if (!open) return
    requestAnimationFrame(() => {
      hourListRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
      minListRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
    })
  }, [open])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false)
  }, [])

  return (
    <div ref={ref} className={`relative inline-block ${className}`} onKeyDown={handleKeyDown}>
      {/* Display button */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 rounded-md border border-neutral-7 bg-neutral-10 px-3 py-2 text-[15px] font-mono text-neutral-1 focus:border-accent-6 focus:outline-none w-40 cursor-pointer hover:border-neutral-5 transition-colors"
      >
        <span className="flex-1 text-left">{pad(hour)}:{pad(minute)}</span>
        {/* Clock icon */}
        <svg className="w-4 h-4 text-neutral-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute top-full left-0 z-50 mt-1 flex rounded-md border border-neutral-7 bg-neutral-10 shadow-lg overflow-hidden">
          {/* Hours column */}
          <div ref={hourListRef} className="h-52 overflow-y-auto scrollbar-thin">
            {HOURS.map(h => (
              <button
                key={h}
                type="button"
                data-selected={h === hour}
                onClick={() => { onChange(h, minute); }}
                className={`block w-full px-4 py-1.5 text-center font-mono text-[14px] transition-colors cursor-pointer
                  ${h === hour
                    ? 'bg-accent-8 text-accent-2'
                    : 'text-neutral-2 hover:bg-neutral-8'
                  }`}
              >
                {pad(h)}
              </button>
            ))}
          </div>

          {/* Divider */}
          <div className="w-px bg-neutral-7" />

          {/* Minutes column */}
          <div ref={minListRef} className="h-52 overflow-y-auto scrollbar-thin">
            {minutes.map(m => (
              <button
                key={m}
                type="button"
                data-selected={m === minute}
                onClick={() => { onChange(hour, m); }}
                className={`block w-full px-4 py-1.5 text-center font-mono text-[14px] transition-colors cursor-pointer
                  ${m === minute
                    ? 'bg-accent-8 text-accent-2'
                    : 'text-neutral-2 hover:bg-neutral-8'
                  }`}
              >
                {pad(m)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
