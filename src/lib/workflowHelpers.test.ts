import { describe, it, expect } from 'vitest'
import {
  buildCron,
  parseCron,
  formatHour,
  describeCron,
  kindLabel,
  kindCategory,
  slugify,
  formatDuration,
  formatTime,
  repoNameFromRun,
  statusBadge,
  toTimeValue,
  fromTimeValue,
} from './workflowHelpers.js'
import type { WorkflowRun } from './workflowApi'

describe('workflowHelpers', () => {
  describe('buildCron', () => {
    it('builds a cron expression', () => {
      expect(buildCron(6, '*')).toBe('0 6 * * *')
      expect(buildCron(14, '1-5')).toBe('0 14 * * 1-5')
      expect(buildCron(0, '0')).toBe('0 0 * * 0')
    })

    it('builds a cron expression with minute', () => {
      expect(buildCron(6, '*', 30)).toBe('30 6 * * *')
      expect(buildCron(14, '1-5', 15)).toBe('15 14 * * 1-5')
    })

    it('builds a biweekly cron expression', () => {
      expect(buildCron(6, 'biweekly')).toBe('0 6 */14 * *')
      expect(buildCron(9, 'biweekly', 45)).toBe('45 9 */14 * *')
    })
  })

  describe('parseCron', () => {
    it('parses a valid 5-field cron expression', () => {
      expect(parseCron('0 6 * * *')).toEqual({ hour: 6, minute: 0, dow: '*' })
      expect(parseCron('0 14 * * 1-5')).toEqual({ hour: 14, minute: 0, dow: '1-5' })
    })

    it('parses minute field', () => {
      expect(parseCron('30 6 * * *')).toEqual({ hour: 6, minute: 30, dow: '*' })
      expect(parseCron('15 14 * * 1-5')).toEqual({ hour: 14, minute: 15, dow: '1-5' })
    })

    it('parses biweekly expression', () => {
      expect(parseCron('0 6 */14 * *')).toEqual({ hour: 6, minute: 0, dow: 'biweekly' })
      expect(parseCron('45 9 */14 * *')).toEqual({ hour: 9, minute: 45, dow: 'biweekly' })
    })

    it('returns defaults for invalid expression', () => {
      expect(parseCron('invalid')).toEqual({ hour: 6, minute: 0, dow: '*' })
      expect(parseCron('* *')).toEqual({ hour: 6, minute: 0, dow: '*' })
    })

    it('handles non-numeric hour', () => {
      expect(parseCron('0 abc * * *')).toEqual({ hour: 0, minute: 0, dow: '*' })
    })
  })

  describe('formatHour', () => {
    it('formats midnight', () => {
      expect(formatHour(0)).toBe('12:00 AM')
    })

    it('formats morning hours', () => {
      expect(formatHour(6)).toBe('6:00 AM')
      expect(formatHour(11)).toBe('11:00 AM')
    })

    it('formats noon', () => {
      expect(formatHour(12)).toBe('12:00 PM')
    })

    it('formats afternoon hours', () => {
      expect(formatHour(13)).toBe('1:00 PM')
      expect(formatHour(23)).toBe('11:00 PM')
    })
  })

  describe('toTimeValue', () => {
    it('pads hour and minute', () => {
      expect(toTimeValue(6, 0)).toBe('06:00')
      expect(toTimeValue(14, 30)).toBe('14:30')
      expect(toTimeValue(0, 15)).toBe('00:15')
    })
  })

  describe('fromTimeValue', () => {
    it('parses time string', () => {
      expect(fromTimeValue('06:00')).toEqual({ hour: 6, minute: 0 })
      expect(fromTimeValue('14:30')).toEqual({ hour: 14, minute: 30 })
    })
  })

  describe('describeCron', () => {
    it('describes daily cron', () => {
      expect(describeCron('0 6 * * *')).toBe('Daily at 06:00')
    })

    it('describes weekday cron', () => {
      expect(describeCron('0 14 * * 1-5')).toBe('Weekdays at 14:00')
    })

    it('describes weekly cron with specific day', () => {
      expect(describeCron('0 9 * * 1')).toBe('Weekly Mon at 09:00')
      expect(describeCron('0 9 * * 0')).toBe('Weekly Sun at 09:00')
    })

    it('describes biweekly cron', () => {
      expect(describeCron('0 6 */14 * *')).toBe('Bi-weekly at 06:00')
      expect(describeCron('30 9 */14 * *')).toBe('Bi-weekly at 09:30')
    })

    it('returns raw expression for invalid format', () => {
      expect(describeCron('invalid')).toBe('invalid')
    })

    it('pads single-digit hours and minutes', () => {
      expect(describeCron('5 8 * * *')).toBe('Daily at 08:05')
    })
  })

  describe('kindLabel', () => {
    it('returns label for known kinds', () => {
      expect(kindLabel('coverage.daily')).toBe('Coverage Assessment')
      expect(kindLabel('code-review.daily')).toBe('Code Review')
    })

    it('returns kind string for unknown kinds', () => {
      expect(kindLabel('unknown-kind')).toBe('unknown-kind')
    })
  })

  describe('kindCategory', () => {
    it('returns category for known kinds', () => {
      expect(kindCategory('coverage.daily')).toBe('assessment')
    })

    it('returns assessment for unknown kinds', () => {
      expect(kindCategory('unknown')).toBe('assessment')
    })
  })

  describe('slugify', () => {
    it('converts to lowercase slug', () => {
      expect(slugify('Hello World')).toBe('hello-world')
      expect(slugify('FOO BAR BAZ')).toBe('foo-bar-baz')
    })

    it('strips leading/trailing hyphens', () => {
      expect(slugify('--hello--')).toBe('hello')
    })

    it('replaces special characters', () => {
      expect(slugify('foo@bar#baz')).toBe('foo-bar-baz')
    })
  })

  describe('formatDuration', () => {
    it('returns dash when no start', () => {
      expect(formatDuration(null, null)).toBe('—')
    })

    it('formats sub-second durations', () => {
      const start = '2026-03-08T00:00:00.000Z'
      const end = '2026-03-08T00:00:00.500Z'
      expect(formatDuration(start, end)).toBe('<1s')
    })

    it('formats seconds', () => {
      const start = '2026-03-08T00:00:00.000Z'
      const end = '2026-03-08T00:00:30.000Z'
      expect(formatDuration(start, end)).toBe('30s')
    })

    it('formats minutes', () => {
      const start = '2026-03-08T00:00:00.000Z'
      const end = '2026-03-08T00:05:00.000Z'
      expect(formatDuration(start, end)).toBe('5m')
    })
  })

  describe('formatTime', () => {
    it('returns dash for null', () => {
      expect(formatTime(null)).toBe('—')
    })

    it('formats a valid ISO string', () => {
      const result = formatTime('2026-03-08T14:30:00.000Z')
      expect(result).toBeTruthy()
      expect(result).not.toBe('—')
    })
  })

  describe('repoNameFromRun', () => {
    it('uses repoName from input', () => {
      const run = { input: { repoName: 'my-repo' } } as unknown as WorkflowRun
      expect(repoNameFromRun(run)).toBe('my-repo')
    })

    it('extracts name from repoPath', () => {
      const run = { input: { repoPath: '/home/user/projects/my-app' } } as unknown as WorkflowRun
      expect(repoNameFromRun(run)).toBe('my-app')
    })

    it('falls back to kind', () => {
      const run = { input: {}, kind: 'test-workflow' } as unknown as WorkflowRun
      expect(repoNameFromRun(run)).toBe('test-workflow')
    })
  })

  describe('statusBadge', () => {
    it('returns correct classes for all statuses', () => {
      expect(statusBadge('succeeded')).toContain('success')
      expect(statusBadge('failed')).toContain('error')
      expect(statusBadge('running')).toContain('animate-pulse')
      expect(statusBadge('queued')).toContain('neutral')
      expect(statusBadge('canceled')).toContain('warning')
      expect(statusBadge('skipped')).toContain('neutral')
      expect(statusBadge('unknown')).toContain('neutral')
    })
  })
})
