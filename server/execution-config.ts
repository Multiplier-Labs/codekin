/**
 * Execution API settings (docs/EXECUTION-API.md §Configuration), from the
 * environment. The API is off unless EXECUTION_ENABLED=1.
 */

import { join } from 'path'
import { DATA_DIR } from './config.js'
import { DEFAULT_LIMITS, type ExecutionLimits } from './execution-service.js'

function int(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < min || n > max) {
    console.warn(`[execution] Ignoring ${name}=${raw} (expected ${min}–${max}); using ${fallback}`)
    return fallback
  }
  return n
}

export interface ExecutionConfig {
  enabled: boolean
  clientsFile: string
  codexHome: string | null
  limits: Partial<ExecutionLimits>
}

export function loadExecutionConfig(): ExecutionConfig {
  return {
    enabled: /^(1|true|yes)$/i.test(process.env.EXECUTION_ENABLED ?? ''),
    clientsFile: process.env.EXECUTION_CLIENTS_FILE || join(DATA_DIR, 'execution-clients.json'),
    codexHome: process.env.EXECUTION_CODEX_HOME || null,
    limits: {
      concurrency: int('EXECUTION_CONCURRENCY', DEFAULT_LIMITS.concurrency, 1, 8),
      maxQueued: int('EXECUTION_MAX_QUEUED', DEFAULT_LIMITS.maxQueued, 1, 10_000),
      backgroundBudgetPercent: int('EXECUTION_BACKGROUND_BUDGET_PERCENT', DEFAULT_LIMITS.backgroundBudgetPercent, 1, 100),
      retentionDays: int('EXECUTION_RETENTION_DAYS', DEFAULT_LIMITS.retentionDays, 1, 7),
    },
  }
}
