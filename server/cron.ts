/**
 * Single cron implementation for the trigger engine.
 *
 * Standard 5-field cron (minute hour dom month dow). This module is the one
 * place cron expressions are parsed, matched, and validated — the engine's
 * scheduler, the route-level validation, and anything Joe schedules must all
 * agree on edge cases, so they all import from here.
 */

function parseCronField(field: string, min: number, max: number): number[] {
  const values: number[] = []
  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/)
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 1
    // Defensive guard — `step <= 0` would make the loops below never advance
    // (or run backwards), pinning the scheduler. Any caller that reaches this
    // branch with a zero/negative step has bypassed isValidCron, so refuse loudly.
    if (!Number.isFinite(step) || step <= 0) {
      throw new Error(`Invalid cron step value: ${stepMatch?.[2]} (must be > 0)`)
    }
    const range = stepMatch ? stepMatch[1] : part

    if (range === '*') {
      for (let i = min; i <= max; i += step) values.push(i)
    } else if (range.includes('-')) {
      const [start, end] = range.split('-').map(Number)
      for (let i = start; i <= end; i += step) values.push(i)
    } else {
      values.push(parseInt(range, 10))
    }
  }
  return values
}

export function cronMatchesDate(expression: string, date: Date): boolean {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) return false

  try {
    const [minF, hourF, domF, monF, dowF] = parts
    const minute = parseCronField(minF, 0, 59)
    const hour = parseCronField(hourF, 0, 23)
    const dom = parseCronField(domF, 1, 31)
    const month = parseCronField(monF, 1, 12)
    const dow = parseCronField(dowF, 0, 6)

    return (
      minute.includes(date.getMinutes()) &&
      hour.includes(date.getHours()) &&
      dom.includes(date.getDate()) &&
      month.includes(date.getMonth() + 1) &&
      dow.includes(date.getDay())
    )
  } catch {
    // Malformed expression (e.g. step 0). Treat as never-matching so a bad
    // legacy schedule cannot pin the scheduler in a tight loop.
    return false
  }
}

/** Compute the next matching minute for a cron expression after `after`. */
export function nextCronMatch(expression: string, after: Date): Date {
  const d = new Date(after)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  // Search up to 366 days ahead
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (cronMatchesDate(expression, d)) return d
    d.setMinutes(d.getMinutes() + 1)
  }
  // Fallback: 24h from now
  return new Date(after.getTime() + 86400000)
}

/** Validate a 5-field cron expression. Returns true if the format is valid. */
export function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return false
  const ranges = [
    [0, 59],  // minute
    [0, 23],  // hour
    [1, 31],  // day of month
    [1, 12],  // month
    [0, 6],   // day of week
  ]
  return parts.every((part, i) => {
    const [min, max] = ranges[i]
    return part.split(',').every(segment => {
      const stepMatch = segment.match(/^(.+)\/(\d+)$/)
      if (stepMatch) {
        const step = parseInt(stepMatch[2], 10)
        if (isNaN(step) || step < 1) return false
      }
      const range = stepMatch ? stepMatch[1] : segment
      if (range === '*') return true
      if (range.includes('-')) {
        const [a, b] = range.split('-').map(Number)
        return !isNaN(a) && !isNaN(b) && a >= min && b <= max && a <= b
      }
      const n = parseInt(range, 10)
      return !isNaN(n) && n >= min && n <= max
    })
  })
}
