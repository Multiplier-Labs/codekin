/** Tests for formatUsage — verifies compact token-count and usage-label formatting. */
import { describe, it, expect } from 'vitest'
import { formatTokenCount, formatUsageLabel } from './formatUsage'

describe('formatTokenCount', () => {
  it('returns small counts as-is', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(950)).toBe('950')
  })

  it('formats thousands with a k suffix', () => {
    expect(formatTokenCount(1_000)).toBe('1.0k')
    expect(formatTokenCount(12_340)).toBe('12.3k')
  })

  it('formats millions with an M suffix', () => {
    expect(formatTokenCount(2_100_000)).toBe('2.1M')
  })
})

describe('formatUsageLabel', () => {
  it('sums input and output tokens', () => {
    expect(formatUsageLabel({ inputTokens: 800, outputTokens: 200 })).toBe('1.0k tok')
  })

  it('appends cost with 3 decimals below $1', () => {
    expect(formatUsageLabel({ inputTokens: 100, outputTokens: 50, costUsd: 0.0421 })).toBe('150 tok · $0.042')
  })

  it('appends cost with 2 decimals at $1 and above', () => {
    expect(formatUsageLabel({ inputTokens: 100, outputTokens: 50, costUsd: 1.5 })).toBe('150 tok · $1.50')
  })

  it('omits cost when zero or absent', () => {
    expect(formatUsageLabel({ inputTokens: 100, outputTokens: 50, costUsd: 0 })).toBe('150 tok')
    expect(formatUsageLabel({ inputTokens: 100, outputTokens: 50 })).toBe('150 tok')
  })
})
