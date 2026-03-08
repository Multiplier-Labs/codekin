# Stepflow API Reference

A durable, type-safe workflow orchestration engine for Node.js with pluggable storage, scheduling, and real-time events.

## Table of Contents

- [Overview](#overview)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [WorkflowEngine](#workflowengine)
- [Workflow Definitions](#workflow-definitions)
- [Step Handlers](#step-handlers)
- [Event System](#event-system)
- [Scheduler](#scheduler)
- [Storage Adapters](#storage-adapters)
- [PostgreSQL Storage Adapter](#postgresql-storage-adapter)
- [Planning System](#planning-system)
- [Error Handling](#error-handling)
- [Utilities](#utilities)
- [TypeScript Types Reference](#typescript-types-reference)
- [Downstream Integration Patterns](#downstream-integration-patterns)

---

## Overview

Stepflow provides:

- **Workflow Definition & Registration** - Define multi-step workflows with typed inputs
- **Async Execution Engine** - Non-blocking, fire-and-forget run execution
- **State Management** - Run/step status tracking with checkpointing for crash recovery
- **Event System** - Real-time events via in-memory, Socket.IO, or webhooks
- **Pluggable Storage** - Memory, SQLite, or PostgreSQL backends
- **Retry & Error Handling** - Configurable per-step error strategies (fail, retry, skip)
- **Scheduling** - Cron-based and workflow-completion triggers
- **Planning** - Rule-based recipe selection and plan generation

---

## Installation

```bash
npm install @multiplier-labs/stepflow
```

### Optional Peer Dependencies

Install based on your storage backend:

```bash
# For SQLite storage
npm install better-sqlite3

# For PostgreSQL storage
npm install pg kysely
```

These are loaded dynamically at runtime, so users of other backends are unaffected.

---

## Quick Start

```typescript
import { WorkflowEngine, MemoryStorageAdapter } from 'stepflow';

const engine = new WorkflowEngine({
  storage: new MemoryStorageAdapter(),
});

engine.registerWorkflow({
  kind: 'email.send_campaign',
  name: 'Send Email Campaign',
  steps: [
    {
      key: 'load_recipients',
      name: 'Load Recipients',
      handler: async (ctx) => {
        const recipients = await loadRecipients(ctx.input.campaignId);
        return { recipients };
      },
    },
    {
      key: 'send_emails',
      name: 'Send Emails',
      handler: async (ctx) => {
        const { recipients } = ctx.results.load_recipients;
        return { sent: recipients.length };
      },
      onError: 'retry',
      maxRetries: 3,
    },
  ],
});

const runId = await engine.startRun({
  kind: 'email.send_campaign',
  input: { campaignId: '123' },
});

engine.subscribeToRun(runId, (event) => {
  console.log(`${event.eventType}: ${event.stepKey ?? 'run'}`);
});
```

---

## WorkflowEngine

The primary entry point for the library.

### Constructor

```typescript
import { WorkflowEngine } from 'stepflow';

const engine = new WorkflowEngine(config?: WorkflowEngineConfig);
```

### Configuration

```typescript
interface WorkflowEngineConfig {
  storage?: StorageAdapter;     // default: MemoryStorageAdapter
  events?: EventTransport;      // default: MemoryEventTransport
  logger?: Logger;              // default: ConsoleLogger
  settings?: {
    defaultTimeout?: number;    // workflow timeout in ms
    maxConcurrency?: number;    // max concurrent workflows
  };
}
```

### Methods

#### Lifecycle

```typescript
// Initialize storage and event adapters (required before use)
await engine.initialize(): Promise<void>;

// Graceful shutdown: cancels active runs, closes transports and storage
await engine.shutdown(): Promise<void>;
```

#### Workflow Registration

```typescript
// Register a workflow definition
engine.registerWorkflow<TInput>(definition: WorkflowDefinition<TInput>): void;

// Unregister a workflow by kind
engine.unregisterWorkflow(kind: string): boolean;

// Get a registered workflow definition
engine.getWorkflow(kind: string): WorkflowDefinition | undefined;

// List all registered workflow kinds
engine.getRegisteredWorkflows(): string[];
```

#### Running Workflows

```typescript
// Start a new run (non-blocking, returns immediately)
const runId = await engine.startRun<TInput>(options: StartRunOptions<TInput>): Promise<string>;

// Cancel a running workflow
await engine.cancelRun(runId: string): Promise<void>;

// Get current run status
const run = await engine.getRunStatus(runId: string): Promise<WorkflowRunRecord | null>;

// Poll until a run completes (for testing or synchronous use cases)
const run = await engine.waitForRun(runId: string, options?: {
  pollInterval?: number;  // default: 100ms
  timeout?: number;       // default: 30000ms
}): Promise<WorkflowRunRecord>;
```

#### Resume & Recovery

```typescript
// Resume a run from its last checkpoint
const newRunId = await engine.resumeRun(runId: string): Promise<string>;

// Get all resumable runs (status 'queued' or 'running')
const runs = await engine.getResumableRuns(): Promise<WorkflowRunRecord[]>;

// Resume all interrupted runs
const runIds = await engine.resumeAllInterrupted(): Promise<string[]>;
```

#### Event Subscriptions

```typescript
// Subscribe to events for a specific run
const unsubscribe = engine.subscribeToRun(runId: string, callback: EventCallback): Unsubscribe;

// Subscribe to all workflow events
const unsubscribe = engine.subscribeToAll(callback: EventCallback): Unsubscribe;
```

#### Introspection

```typescript
engine.getActiveRunCount(): number;
engine.getQueuedRunCount(): number;
engine.getStorage(): StorageAdapter;
engine.getEvents(): EventTransport;
```

### StartRunOptions

```typescript
interface StartRunOptions<TInput = Record<string, unknown>> {
  kind: string;                           // workflow type to run
  input?: TInput;                         // input parameters
  metadata?: Record<string, unknown>;     // optional metadata (userId, etc.)
  parentRunId?: string;                   // parent run ID (for child workflows)
  delay?: number;                         // delay before starting (ms)
  priority?: number;                      // queue priority (higher = runs first, default: 0)
}
```

---

## Workflow Definitions

### WorkflowDefinition

```typescript
interface WorkflowDefinition<TInput = Record<string, unknown>> {
  kind: string;                           // unique workflow type identifier
  name: string;                           // human-readable name
  description?: string;
  steps: WorkflowStep<TInput>[];          // ordered list of steps
  defaultOnError?: StepErrorStrategy;     // default: 'fail'
  timeout?: number;                       // workflow timeout in ms
  hooks?: WorkflowHooks<TInput>;          // lifecycle hooks
}
```

### WorkflowStep

```typescript
interface WorkflowStep<TInput = Record<string, unknown>> {
  key: string;                // unique step identifier within the workflow
  name: string;               // human-readable name
  handler: (ctx: WorkflowContext<TInput>) => Promise<unknown>;
  onError?: StepErrorStrategy;  // 'fail' | 'retry' | 'skip' (default: inherited)
  maxRetries?: number;          // default: 3
  retryDelay?: number;          // default: 1000ms
  retryBackoff?: number;        // default: 2 (exponential)
  timeout?: number;             // step timeout in ms
  skipIf?: (ctx: WorkflowContext<TInput>) => boolean | Promise<boolean>;
}
```

### WorkflowHooks

```typescript
interface WorkflowHooks<TInput = Record<string, unknown>> {
  beforeRun?: (ctx: WorkflowContext<TInput>) => Promise<void>;
  afterRun?: (ctx: WorkflowContext<TInput>, result: RunResult) => Promise<void>;
  beforeStep?: (ctx: WorkflowContext<TInput>, step: WorkflowStep<TInput>) => Promise<void>;
  afterStep?: (ctx: WorkflowContext<TInput>, step: WorkflowStep<TInput>, result: unknown) => Promise<void>;
  onStepError?: (ctx: WorkflowContext<TInput>, step: WorkflowStep<TInput>, error: Error) => Promise<void>;
}
```

---

## Step Handlers

### WorkflowContext

Every step handler receives a `WorkflowContext`:

```typescript
interface WorkflowContext<TInput = Record<string, unknown>> {
  runId: string;                    // unique run ID
  stepId: string;                   // unique step ID (for granular tracking)
  kind: string;                     // workflow type
  input: TInput;                    // run input parameters
  results: Record<string, unknown>; // accumulated results from prior steps (keyed by step key)
  metadata: Record<string, unknown>;// optional metadata
  currentStep?: string;             // current step key
  logger: Logger;                   // scoped logger
  signal: AbortSignal;              // for cancellation
  spawnChild: (options: SpawnChildOptions) => Promise<string>;
  emit: (eventType: string, payload?: unknown) => void;
}
```

### Spawning Child Workflows

```typescript
interface SpawnChildOptions {
  kind: string;
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

// Usage inside a step handler:
const childRunId = await ctx.spawnChild({
  kind: 'child.workflow',
  input: { parentData: ctx.results.step1 },
});
```

### Emitting Custom Events

```typescript
// Inside a step handler:
ctx.emit('progress.update', { percent: 50 });
```

### Execution Flow

1. Run status set to `'running'`
2. `run.started` event emitted
3. `beforeRun` hook called
4. For each step (in order):
   - Cancellation signal checked
   - Skipped if in checkpoint (resume) or `skipIf` returns true
   - `beforeStep` hook called
   - Handler executed with timeout
   - Result stored; `afterStep` hook called; `step.completed` event emitted
   - On error: `step.failed` event, `onStepError` hook, then fail/retry/skip per strategy
   - Checkpoint saved after each successful step
5. `afterRun` hook called
6. Run marked `'succeeded'` or `'failed'`

---

## Event System

### Built-in Event Types

```typescript
type BuiltInEventType =
  | 'run.created'   | 'run.queued'    | 'run.dequeued'
  | 'run.started'   | 'run.resumed'   | 'run.completed'
  | 'run.failed'    | 'run.canceled'  | 'run.timeout'
  | 'step.started'  | 'step.completed'
  | 'step.failed'   | 'step.skipped'  | 'step.retry';
```

### WorkflowEvent

```typescript
interface WorkflowEvent {
  runId: string;
  kind: string;
  eventType: string;        // BuiltInEventType or custom string
  stepKey?: string;
  timestamp: Date;
  payload?: unknown;
}
```

### EventTransport Interface

```typescript
interface EventTransport {
  emit(event: WorkflowEvent): void;
  subscribe(runId: string, callback: EventCallback): Unsubscribe;
  subscribeAll(callback: EventCallback): Unsubscribe;
  subscribeToType?(eventType: string, callback: EventCallback): Unsubscribe;
  persist?(event: WorkflowEvent): Promise<void>;
  close?(): void;
}

type EventCallback = (event: WorkflowEvent) => void;
type Unsubscribe = () => void;
```

### MemoryEventTransport

Default in-memory transport. Supports `subscribeToType()`.

```typescript
import { MemoryEventTransport } from 'stepflow';

const events = new MemoryEventTransport();
events.getListenerCount(channel?: string): number;
```

### SocketIOEventTransport

Real-time events via Socket.IO.

```typescript
import { SocketIOEventTransport } from 'stepflow';

const events = new SocketIOEventTransport({
  io: socketIOServer,
  eventName: 'workflow:event',        // default
  roomPrefix: 'run:',                 // default
  broadcastGlobal: true,              // default
  globalRoom: 'workflow:all',         // default
});

// Set up client handlers for a socket connection
events.setupClientHandlers(socket);
```

**Client events:** `workflow:subscribe`, `workflow:unsubscribe`, `workflow:subscribe:all`, `workflow:unsubscribe:all`

### WebhookEventTransport

Delivers events to HTTP endpoints with HMAC-SHA256 signing.

```typescript
import { WebhookEventTransport } from 'stepflow';

const events = new WebhookEventTransport({
  endpoints: [
    {
      id: 'my-webhook',
      url: 'https://example.com/webhook',
      secret: 'my-secret',           // for HMAC-SHA256 signing
      eventTypes: ['run.completed'],  // filter (optional)
      workflowKinds: ['my.workflow'], // filter (optional)
      headers: { 'X-Custom': 'val' },
      enabled: true,                  // default: true
      timeout: 5000,                  // default: 5000ms
      retries: 3,                     // default: 3
    },
  ],
  defaultTimeout: 5000,              // default
  defaultRetries: 3,                 // default
  retryDelay: 1000,                  // default
  fetchFn: fetch,                    // custom fetch (optional)
});

events.addEndpoint(endpoint);
events.removeEndpoint(id: string): boolean;
events.getEndpoints(): WebhookEndpoint[];
events.setEndpointEnabled(id: string, enabled: boolean): void;
```

**Webhook payload:**

```typescript
interface WebhookPayload {
  event: { runId, kind, eventType, stepKey?, payload?, timestamp: string };
  deliveredAt: string;
  webhookId: string;
}
```

Signed with `X-Webhook-Signature` header (HMAC-SHA256).

---

## Scheduler

### CronScheduler

```typescript
import { CronScheduler } from 'stepflow';

const scheduler = new CronScheduler({
  engine: workflowEngine,
  logger: myLogger,                  // optional
  pollInterval: 1000,                // default: 1000ms
  persistence: myPersistence,        // optional SchedulePersistence
});

await scheduler.start();

// Add a cron schedule
const schedule = await scheduler.addSchedule({
  workflowKind: 'reports.generate',
  triggerType: 'cron',
  cronExpression: '0 6 * * *',      // daily at 6 AM
  timezone: 'UTC',
  input: { format: 'pdf' },
  enabled: true,
});

// Add a workflow-completion trigger
await scheduler.addSchedule({
  workflowKind: 'cleanup.run',
  triggerType: 'workflow_completed',
  triggerOnWorkflowKind: 'data.import',
  triggerOnStatus: ['succeeded'],
  enabled: true,
});

// Manage schedules
await scheduler.removeSchedule(scheduleId);
await scheduler.updateSchedule(scheduleId, { enabled: false });
const schedules = await scheduler.getSchedules();
const schedule = scheduler.getSchedule(scheduleId);
const runId = await scheduler.triggerNow(scheduleId);

await scheduler.stop();
```

### WorkflowSchedule

```typescript
interface WorkflowSchedule {
  id: string;
  workflowKind: string;
  triggerType: 'cron' | 'workflow_completed' | 'manual';
  cronExpression?: string;
  timezone?: string;
  triggerOnWorkflowKind?: string;
  triggerOnStatus?: RunStatus[];
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  enabled: boolean;
  lastRunAt?: Date;
  lastRunId?: string;
  nextRunAt?: Date;
}
```

### SchedulePersistence Interface

```typescript
interface SchedulePersistence {
  loadSchedules(): Promise<WorkflowSchedule[]>;
  saveSchedule(schedule: WorkflowSchedule): Promise<void>;
  updateSchedule(scheduleId: string, updates: Partial<WorkflowSchedule>): Promise<void>;
  deleteSchedule(scheduleId: string): Promise<void>;
}
```

### SQLiteSchedulePersistence

```typescript
import { SQLiteSchedulePersistence } from 'stepflow';

const persistence = new SQLiteSchedulePersistence({
  db: sqliteDatabase,
  tableName: 'workflow_schedules',  // default
});
```

### PostgresSchedulePersistence

```typescript
import { PostgresSchedulePersistence } from 'stepflow';

const persistence = new PostgresSchedulePersistence({
  connectionString: process.env.DATABASE_URL,
  // OR pool: existingPgPool,
  // OR poolConfig: { ... },
  schema: 'public',                 // default
  tableName: 'workflow_schedules',  // default
  autoMigrate: true,                // default
});

await persistence.initialize();

// Additional query methods:
await persistence.getSchedule(scheduleId): Promise<WorkflowSchedule | null>;
await persistence.getDueSchedules(): Promise<WorkflowSchedule[]>;
await persistence.getSchedulesByWorkflowKind(kind): Promise<WorkflowSchedule[]>;
await persistence.getCompletionTriggers(triggerOnKind): Promise<WorkflowSchedule[]>;

await persistence.close();
```

---

## Storage Adapters

All storage adapters implement the `StorageAdapter` interface.

### StorageAdapter Interface

```typescript
interface StorageAdapter {
  // Run operations
  createRun(run: Omit<WorkflowRunRecord, 'id' | 'createdAt'>): Promise<WorkflowRunRecord>;
  getRun(runId: string): Promise<WorkflowRunRecord | null>;
  updateRun(runId: string, updates: Partial<WorkflowRunRecord>): Promise<void>;
  listRuns(options?: ListRunsOptions): Promise<PaginatedResult<WorkflowRunRecord>>;

  // Step operations
  createStep(step: Omit<WorkflowRunStepRecord, 'id'>): Promise<WorkflowRunStepRecord>;
  getStep(stepId: string): Promise<WorkflowRunStepRecord | null>;
  updateStep(stepId: string, updates: Partial<WorkflowRunStepRecord>): Promise<void>;
  getStepsForRun(runId: string): Promise<WorkflowRunStepRecord[]>;

  // Event operations
  saveEvent(event: Omit<WorkflowEventRecord, 'id'>): Promise<void>;
  getEventsForRun(runId: string, options?: ListEventsOptions): Promise<WorkflowEventRecord[]>;

  // Optional
  transaction?<T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T>;
  deleteOldRuns?(olderThan: Date): Promise<number>;
  initialize?(): Promise<void>;
  close?(): void | Promise<void>;
}
```

### WorkflowStorage Interface

A newer storage interface with additional methods for queue management and step results. The `PostgresStorageAdapter` implements both `StorageAdapter` and `WorkflowStorage`.

```typescript
interface WorkflowStorage {
  // Run operations
  createRun(run: CreateRunInput): Promise<ExtendedWorkflowRunRecord>;
  getRun(id: string): Promise<ExtendedWorkflowRunRecord | null>;
  updateRun(id: string, updates: UpdateRunInput): Promise<void>;
  listRuns(options?: ExtendedListRunsOptions): Promise<PaginatedResult<ExtendedWorkflowRunRecord>>;
  deleteRun(id: string): Promise<void>;

  // Atomic dequeue
  dequeueRun(workflowKinds: string[]): Promise<ExtendedWorkflowRunRecord | null>;

  // Stale run management
  cleanupStaleRuns(defaultTimeoutMs?: number): Promise<number>;
  markRunsAsFailed(runIds: string[], reason: string): Promise<void>;

  // Step results (uses stepflow_step_results table)
  getStepResult(runId: string, stepName: string): Promise<StepResult | undefined>;
  getStepResults(runId: string): Promise<StepResult[]>;
  getStepsForRun(runId: string): Promise<StepRecord[]>;
  saveStepResult(result: Omit<StepResult, 'id'> & { id?: string }): Promise<void>;

  // Lifecycle
  initialize(): Promise<void>;
  close(): Promise<void>;
}
```

### Core Record Types

```typescript
interface WorkflowRunRecord {
  id: string;
  kind: string;
  status: RunStatus;                             // 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
  parentRunId?: string;
  input: Record<string, unknown>;
  context: Record<string, unknown>;              // checkpoint: accumulated step results
  output?: Record<string, unknown>;
  error?: { code: string; message: string };
  metadata?: Record<string, unknown>;
  priority?: number;
  timeoutMs?: number;
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
}

interface WorkflowRunStepRecord {
  id: string;
  runId: string;
  stepKey: string;
  stepName: string;
  status: StepStatus;                            // 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'
  attempt: number;
  result?: unknown;
  error?: WorkflowError;
  startedAt?: Date;
  finishedAt?: Date;
}

interface WorkflowEventRecord {
  id: string;
  runId: string;
  stepKey?: string;
  eventType: string;
  level: 'info' | 'warn' | 'error';
  payload?: unknown;
  timestamp: Date;
}
```

### Extended Types

Used by the `WorkflowStorage` interface and `PostgresStorageAdapter`:

```typescript
// Adds 'pending' and 'timeout' to core RunStatus
type ExtendedRunStatus = 'pending' | 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'timeout';

// Uses 'completed' instead of 'succeeded'
type ExtendedStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

interface StepResult {
  id: string;
  runId: string;
  stepName: string;
  status: ExtendedStepStatus;
  output?: Record<string, unknown>;
  error?: Record<string, unknown>;
  attempt: number;
  startedAt?: Date;
  completedAt?: Date;
}

interface StepRecord {
  stepKey: string;
  stepName: string;
  status: ExtendedStepStatus;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
  attempt: number;
  startedAt?: Date;
  finishedAt?: Date;
}
```

### Query Options

```typescript
interface ListRunsOptions {
  kind?: string;
  status?: RunStatus | RunStatus[];
  parentRunId?: string;
  limit?: number;                        // default: 50
  offset?: number;                       // default: 0
  orderBy?: 'createdAt' | 'startedAt' | 'finishedAt';
  orderDirection?: 'asc' | 'desc';      // default: 'desc'
}

interface ExtendedListRunsOptions {
  kind?: string;
  status?: ExtendedRunStatus | ExtendedRunStatus[];
  limit?: number;
  offset?: number;
  orderBy?: 'createdAt' | 'startedAt' | 'finishedAt';
  orderDir?: 'asc' | 'desc';
}

interface ListEventsOptions {
  stepKey?: string;
  level?: 'info' | 'warn' | 'error';
  limit?: number;                        // default: 1000
  offset?: number;
}

interface PaginatedResult<T> {
  items: T[];
  total: number;
  limit?: number;
  offset?: number;
}
```

### MemoryStorageAdapter

In-memory storage. Data is lost on process exit.

```typescript
import { MemoryStorageAdapter } from 'stepflow';

const storage = new MemoryStorageAdapter();

// Testing utilities
storage.clear(): void;
storage.getStats(): { runs: number; steps: number; events: number };
```

### SQLiteStorageAdapter

File-based or in-memory SQLite storage.

```typescript
import { SQLiteStorageAdapter } from 'stepflow';
import Database from 'better-sqlite3';

const db = new Database('./workflows.db');
const storage = new SQLiteStorageAdapter({
  db,
  autoCreateTables: true,    // default: true
  tablePrefix: 'workflow',   // default: 'workflow'
});

// Additional methods
storage.transactionSync<T>(fn: () => T): T;
await storage.getInterruptedRuns(): Promise<WorkflowRunRecord[]>;
await storage.getLastCompletedStep(runId): Promise<WorkflowRunStepRecord | null>;
storage.close(): void;
storage.getStats(): { runs: number; steps: number; events: number };
```

**Tables created:** `workflow_runs`, `workflow_run_steps`, `workflow_events`

---

## PostgreSQL Storage Adapter

Production-ready PostgreSQL backend with connection pooling, distributed worker support, and atomic dequeue.

### Configuration

```typescript
import { PostgresStorageAdapter } from 'stepflow';

interface PostgresStorageConfig {
  connectionString?: string;    // e.g., "postgresql://user:pass@localhost:5432/dbname"
  pool?: pg.Pool;               // existing pool for connection sharing
  poolConfig?: pg.PoolConfig;   // pool configuration options
  schema?: string;              // schema name (default: 'public')
  autoMigrate?: boolean;        // auto-create tables (default: true)
}
```

### Usage

```typescript
// Option 1: Connection string
const storage = new PostgresStorageAdapter({
  connectionString: process.env.DATABASE_URL,
  schema: 'stepflow',
});
await storage.initialize();

// Option 2: Existing pool (for connection sharing)
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
const storage = new PostgresStorageAdapter({ pool, schema: 'stepflow' });
await storage.initialize();

// Use with engine
const engine = new WorkflowEngine({ storage });
await engine.initialize();
```

The adapter only closes the pool on `close()` if it created it. Externally-provided pools are left open.

### All Methods

The adapter implements both `StorageAdapter` and `WorkflowStorage`, providing:

**StorageAdapter methods (legacy, used by WorkflowEngine):**

```typescript
await storage.createRun(run): Promise<WorkflowRunRecord>;
await storage.getRun(runId): Promise<WorkflowRunRecord | null>;
await storage.updateRun(runId, updates): Promise<void>;
await storage.listRuns(options?): Promise<PaginatedResult<WorkflowRunRecord>>;
await storage.createStep(step): Promise<WorkflowRunStepRecord>;
await storage.getStep(stepId): Promise<WorkflowRunStepRecord | null>;
await storage.updateStep(stepId, updates): Promise<void>;
await storage.getStepsForRun(runId): Promise<WorkflowRunStepRecord[]>;
await storage.saveEvent(event): Promise<void>;
await storage.getEventsForRun(runId, options?): Promise<WorkflowEventRecord[]>;
await storage.transaction<T>(fn): Promise<T>;
await storage.deleteOldRuns(olderThan): Promise<number>;
await storage.initialize(): Promise<void>;
await storage.close(): Promise<void>;
```

**WorkflowStorage methods (used for queue operations and step results):**

```typescript
await storage.deleteRun(id): Promise<void>;
await storage.dequeueRun(workflowKinds?): Promise<WorkflowRunRecord | null>;
await storage.cleanupStaleRuns(defaultTimeoutMs?): Promise<number>;
await storage.markRunsAsFailed(runIds, reason): Promise<void>;
await storage.getStepResult(runId, stepName): Promise<StepResult | undefined>;
await storage.getStepResults(runId): Promise<StepResult[]>;
await storage.saveStepResult(result): Promise<void>;
```

**Resume support:**

```typescript
await storage.getInterruptedRuns(): Promise<WorkflowRunRecord[]>;
await storage.getLastCompletedStep(runId): Promise<WorkflowRunStepRecord | null>;
```

**Diagnostics:**

```typescript
await storage.getStats(): Promise<{ runs: number; steps: number; events: number }>;
```

### Atomic Dequeue

Safe concurrent processing by multiple workers using `FOR UPDATE SKIP LOCKED`:

```typescript
const run = await storage.dequeueRun(['sync.xero', 'sync.directo']);
if (run) {
  // run.status is now 'running', startedAt is set
  console.log(`Processing ${run.kind}: ${run.id}`);
}
```

The dequeue query:

```sql
UPDATE {schema}.runs
SET status = 'running', started_at = NOW()
WHERE id = (
  SELECT id FROM {schema}.runs
  WHERE status = 'queued' AND kind = ANY($1::text[])
  ORDER BY priority DESC, created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

This ensures: one worker per run, priority ordering, FIFO within same priority, no blocking between workers.

### Stale Run Cleanup

```typescript
// Mark runs as timed out if they exceed their timeout_ms (or a default of 10 minutes)
const count = await storage.cleanupStaleRuns(600000);

// Mark specific runs as failed (e.g., during graceful shutdown)
await storage.markRunsAsFailed([runId1, runId2], 'Worker process was terminated');
```

### Step Results (WorkflowStorage Interface)

```typescript
// Save or upsert a step result (uses ON CONFLICT DO UPDATE on run_id + step_name)
await storage.saveStepResult({
  runId: run.id,
  stepName: 'xero.accounts',
  status: 'running',
  attempt: 1,
  startedAt: new Date(),
});

// Get a single step result
const step = await storage.getStepResult(runId, 'xero.accounts');

// Get all step results for a run
const steps = await storage.getStepResults(runId);
```

### Database Schema

When `autoMigrate` is enabled (default), the adapter creates the following tables. All table names are prefixed with the configured `schema` (default: `'public'`).

#### Table: `{schema}.runs`

```sql
CREATE TABLE IF NOT EXISTS {schema}.runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  parent_run_id TEXT,
  input_json JSONB NOT NULL DEFAULT '{}',
  metadata_json JSONB NOT NULL DEFAULT '{}',
  context_json JSONB NOT NULL DEFAULT '{}',
  output_json JSONB,
  error_json JSONB,
  priority INTEGER NOT NULL DEFAULT 0,
  timeout_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  CONSTRAINT runs_status_check CHECK (
    status IN ('pending', 'queued', 'running', 'succeeded', 'failed', 'canceled', 'timeout')
  )
);

CREATE INDEX idx_runs_kind_status ON {schema}.runs (kind, status);
CREATE INDEX idx_runs_parent ON {schema}.runs (parent_run_id);
CREATE INDEX idx_runs_created ON {schema}.runs (created_at DESC);
CREATE INDEX idx_runs_status ON {schema}.runs (status);
CREATE INDEX idx_runs_priority ON {schema}.runs (priority DESC, created_at ASC);
```

#### Table: `{schema}.workflow_run_steps`

Used by the `StorageAdapter` interface (legacy step tracking by the engine).

```sql
CREATE TABLE IF NOT EXISTS {schema}.workflow_run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES {schema}.runs (id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  step_name TEXT,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  result_json JSONB,
  error_json JSONB,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  CONSTRAINT workflow_run_steps_status_check CHECK (
    status IN ('pending', 'running', 'succeeded', 'failed', 'skipped', 'completed')
  )
);

CREATE INDEX idx_workflow_run_steps_run ON {schema}.workflow_run_steps (run_id);
CREATE INDEX idx_workflow_run_steps_run_key ON {schema}.workflow_run_steps (run_id, step_key);
```

#### Table: `{schema}.stepflow_step_results`

Used by the `WorkflowStorage` interface (step result tracking for external consumers).

```sql
CREATE TABLE IF NOT EXISTS {schema}.stepflow_step_results (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  run_id TEXT NOT NULL REFERENCES {schema}.runs (id) ON DELETE CASCADE,
  step_name TEXT NOT NULL,
  status TEXT NOT NULL,
  output_json JSONB,
  error_json JSONB,
  attempt INTEGER NOT NULL DEFAULT 1,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CONSTRAINT stepflow_step_results_status_check CHECK (
    status IN ('pending', 'running', 'completed', 'failed', 'skipped')
  ),
  UNIQUE (run_id, step_name)
);

CREATE INDEX idx_stepflow_step_results_run ON {schema}.stepflow_step_results (run_id);
CREATE INDEX idx_stepflow_step_results_run_name ON {schema}.stepflow_step_results (run_id, step_name);
```

#### Table: `{schema}.workflow_events`

```sql
CREATE TABLE IF NOT EXISTS {schema}.workflow_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES {schema}.runs (id) ON DELETE CASCADE,
  step_key TEXT,
  event_type TEXT NOT NULL,
  level TEXT NOT NULL,
  payload_json JSONB,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workflow_events_level_check CHECK (
    level IN ('info', 'warn', 'error')
  )
);

CREATE INDEX idx_workflow_events_run ON {schema}.workflow_events (run_id);
CREATE INDEX idx_workflow_events_run_ts ON {schema}.workflow_events (run_id, timestamp);
```

### Implementation Notes

- **IDs are TEXT, not UUID.** The adapter uses `generateId()` which produces ULID-like base36 strings (~16 characters) for time-ordering and collision resistance.
- **JSONB columns use `_json` suffix** (e.g., `input_json`, `output_json`, `error_json`) to distinguish from the camelCase TypeScript field names.
- **`finished_at` (not `completed_at`)** is used on the `runs` table. The `stepflow_step_results` table uses `completed_at`.
- **Lazy dependency loading.** `pg` and `kysely` are imported dynamically in `initialize()`, so they're only needed if you actually use the PostgreSQL adapter.
- **Schema isolation.** All queries use `db.withSchema(schema)` to support custom schemas and multi-tenant deployments.
- **Transaction support.** `storage.transaction(fn)` wraps operations in a PostgreSQL transaction via Kysely.

### SQL Queries for Debugging

```sql
-- Recent workflow runs
SELECT id, kind, status, created_at, started_at, finished_at,
       error_json->>'message' as error_message
FROM {schema}.runs
ORDER BY created_at DESC
LIMIT 20;

-- Step results for a run
SELECT step_name, status, output_json, error_json, started_at, completed_at
FROM {schema}.stepflow_step_results
WHERE run_id = 'your-run-id'
ORDER BY started_at;

-- Count by status
SELECT status, COUNT(*) FROM {schema}.runs GROUP BY status;

-- Find stale running workflows
SELECT id, kind, started_at, timeout_ms
FROM {schema}.runs
WHERE status = 'running'
  AND started_at < NOW() - INTERVAL '10 minutes';

-- Queue depth
SELECT kind, COUNT(*) FROM {schema}.runs
WHERE status = 'queued' GROUP BY kind;
```

---

## Planning System

The planning system enables dynamic workflow construction from recipes and step handler registries.

### Recipes

A recipe is a template for building a workflow plan:

```typescript
interface Recipe {
  id: string;
  name: string;
  description?: string;
  workflowKind: string;
  variant: string;                  // e.g., 'default', 'fast', 'thorough'
  steps: RecipeStep[];
  defaults?: RecipeDefaults;
  conditions?: RecipeCondition[];   // conditions for recipe selection
  priority?: number;                // higher = preferred
  tags?: string[];
}

interface RecipeStep {
  key: string;
  name: string;
  handlerRef: string;               // reference to a registered step handler
  config?: Record<string, unknown>;
  onError?: StepErrorStrategy;
  maxRetries?: number;
  retryDelay?: number;
  retryBackoff?: number;
  timeout?: number;
  skipCondition?: string;           // field reference (dot notation)
}

interface RecipeDefaults {
  timeout?: number;
  maxRetries?: number;
  retryDelay?: number;
  retryBackoff?: number;
  onError?: StepErrorStrategy;
}
```

### Conditions

```typescript
type ConditionOperator =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'contains' | 'matches' | 'exists' | 'notExists';

interface RecipeCondition {
  field: string;                    // supports dot notation
  operator: ConditionOperator;
  value?: unknown;
}
```

### Registries

```typescript
import { MemoryRecipeRegistry, MemoryStepHandlerRegistry, createRegistry } from 'stepflow';

// Create both registries at once
const { recipes, handlers } = createRegistry();

// Register step handlers
handlers.register({
  id: 'fetch-data',
  name: 'Fetch Data',
  description: 'Fetches data from API',
  tags: ['io', 'api'],
  handler: async (ctx) => { /* ... */ },
});

// Register recipes
recipes.register({
  id: 'data-pipeline-default',
  name: 'Data Pipeline',
  workflowKind: 'data.pipeline',
  variant: 'default',
  steps: [
    { key: 'fetch', name: 'Fetch', handlerRef: 'fetch-data' },
  ],
});

// Query recipes
recipes.getByKind('data.pipeline'): Recipe[];
recipes.getVariant('data.pipeline', 'fast'): Recipe | undefined;
recipes.getDefault('data.pipeline'): Recipe | undefined;
recipes.listVariants('data.pipeline'): string[];
recipes.query({ workflowKind: 'data.pipeline', tags: ['fast'] }): Recipe[];
```

### RuleBasedPlanner

Selects recipes based on conditions and generates execution plans:

```typescript
import { RuleBasedPlanner } from 'stepflow';

const planner = new RuleBasedPlanner({
  recipeRegistry: recipes,
  handlerRegistry: handlers,      // optional
  validateHandlers: true,         // validate handler refs exist
});

// Select best recipe for given input
const selection = await planner.selectRecipe('data.pipeline', { size: 'large' });

// Generate a full plan
const plan = await planner.plan('data.pipeline', { size: 'large' }, {
  constraints: { maxDuration: 60000, priority: 'speed' },
  hints: { preferredVariant: 'fast', skipSteps: ['optional-step'] },
});

// Validate and estimate
const validation = planner.validatePlan(plan);
const estimate = planner.estimateResources(plan);
```

### Plan Output

```typescript
interface Plan {
  id: string;
  recipeId: string;
  variant: string;
  modifications: PlanModification[];
  steps: PlannedStep[];
  childWorkflows?: ChildWorkflowPlan[];
  defaults: RecipeDefaults;
  reasoning?: string;
  resourceEstimate?: ResourceEstimate;
  createdAt: Date;
}

interface ResourceEstimate {
  apiCalls?: number;
  tokens?: number;
  duration?: number;
  memory?: number;
}
```

---

## Error Handling

### Error Classes

```typescript
import {
  WorkflowEngineError,
  WorkflowNotFoundError,
  WorkflowAlreadyRegisteredError,
  RunNotFoundError,
  StepError,
  StepTimeoutError,
  WorkflowCanceledError,
  WorkflowTimeoutError,
} from 'stepflow';
```

| Class | Code | Constructor |
|-------|------|-------------|
| `WorkflowEngineError` | (custom) | `(code, message, details?)` |
| `WorkflowNotFoundError` | `WORKFLOW_NOT_FOUND` | `(kind)` |
| `WorkflowAlreadyRegisteredError` | `WORKFLOW_ALREADY_REGISTERED` | `(kind)` |
| `RunNotFoundError` | `RUN_NOT_FOUND` | `(runId)` |
| `StepError` | `STEP_ERROR` | `(stepKey, message, attempt, cause?)` |
| `StepTimeoutError` | `STEP_TIMEOUT` | `(stepKey, timeoutMs)` |
| `WorkflowCanceledError` | `WORKFLOW_CANCELED` | `(runId)` |
| `WorkflowTimeoutError` | `WORKFLOW_TIMEOUT` | `(runId, timeoutMs)` |

### WorkflowError Record

```typescript
interface WorkflowError {
  code: string;
  message: string;
  stack?: string;
  details?: Record<string, unknown>;
}

// Convert error instances
const record = engineError.toRecord();
const record = WorkflowEngineError.fromError(unknownError, 'DEFAULT_CODE');
```

### Step Error Strategies

| Strategy | Behavior |
|----------|----------|
| `'fail'` | Stop the workflow immediately (default) |
| `'retry'` | Retry up to `maxRetries` times with exponential backoff |
| `'skip'` | Mark step as skipped and continue to next step |

### RunResult

```typescript
interface RunResult {
  status: 'succeeded' | 'failed' | 'canceled';
  results: Record<string, unknown>;
  error?: WorkflowError;
  duration: number;  // ms
}
```

---

## Utilities

### ID Generation

```typescript
import { generateId } from 'stepflow';

const id = generateId();
// ULID-like format: base36 timestamp + random suffix (~16 characters)
// Time-ordered, collision-resistant, URL-safe
```

### Logger

```typescript
import { ConsoleLogger, SilentLogger, createScopedLogger } from 'stepflow';

// Logs to console with prefix
const logger = new ConsoleLogger('[my-app]');  // default prefix: '[workflow]'

// No-op logger
const silent = new SilentLogger();

// Create a scoped logger (prefixes messages with runId/stepKey)
const scoped = createScopedLogger(logger, runId, stepKey?);

// Logger interface (compatible with pino, winston, etc.)
interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}
```

### Retry Utilities

```typescript
import { withRetry, sleep, calculateRetryDelay, DEFAULT_RETRY_OPTIONS } from 'stepflow';

// Retry a function with exponential backoff
const result = await withRetry(
  () => fetchFromApi(),
  {
    maxRetries: 3,       // default: 3
    delay: 1000,         // default: 1000ms
    backoff: 2,          // default: 2 (exponential)
    signal: abortSignal, // optional
    onRetry: (attempt, error, nextDelay) => {
      console.log(`Retry ${attempt}, next delay: ${nextDelay}ms`);
    },
  }
);

// Sleep with abort support
await sleep(1000, abortSignal?);

// Calculate delay for a given attempt
const delay = calculateRetryDelay(attempt, baseDelay, backoff);
```

---

## TypeScript Types Reference

All types are exported from the main entry point:

```typescript
import type {
  // Core
  WorkflowKind, RunStatus, StepStatus, StepErrorStrategy,
  WorkflowError, RunResult, Logger, SpawnChildOptions,
  WorkflowContext, WorkflowStep, WorkflowHooks, WorkflowDefinition,

  // Engine
  WorkflowEngineConfig, StartRunOptions,

  // Storage (legacy)
  StorageAdapter, WorkflowRunRecord, WorkflowRunStepRecord,
  WorkflowEventRecord, ListRunsOptions, ListEventsOptions,
  PaginatedResult,

  // Storage (extended)
  WorkflowStorage, ExtendedWorkflowRunRecord, ExtendedRunStatus,
  ExtendedStepStatus, ExtendedListRunsOptions,
  CreateRunInput, UpdateRunInput, StepResult, StepRecord,
  StepflowRunsTable, StepflowStepResultsTable, StepflowDatabase,

  // Events
  EventTransport, WorkflowEvent, WorkflowEventType,
  BuiltInEventType, EventCallback, Unsubscribe,
  SocketIOEventTransportConfig, WebhookEventTransportConfig,
  WebhookEndpoint, WebhookPayload,

  // Scheduler
  TriggerType, WorkflowSchedule, Scheduler,
  CronSchedulerConfig, SchedulePersistence,
  PostgresSchedulePersistenceConfig,

  // Planning
  Recipe, RecipeStep, RecipeCondition, RecipeDefaults,
  Plan, PlannedStep, PlanModification, PlanModificationType,
  Planner, PlanningContext, PlanningConstraints, PlanningHints,
  ResourceEstimate, RecipeSelectionResult, PlanValidationResult,
  StepHandlerRegistry, RecipeRegistry, RegisteredStepHandler,
  RecipeQueryOptions, ConditionOperator, StepHandlerRef,
  ChildWorkflowPlan, PlanningPriority,

  // Config
  PostgresStorageConfig, SQLiteStorageConfig,
  SQLiteSchedulePersistenceConfig,

  // Retry
  RetryOptions,
} from 'stepflow';

// Classes and values
import {
  WorkflowEngine,
  MemoryStorageAdapter, SQLiteStorageAdapter,
  PostgresStorageAdapter, PostgresStorageAdapter as PostgresStorage,
  MemoryEventTransport, SocketIOEventTransport, WebhookEventTransport,
  CronScheduler, SQLiteSchedulePersistence, PostgresSchedulePersistence,
  MemoryStepHandlerRegistry, MemoryRecipeRegistry,
  createRegistry, RuleBasedPlanner,
  WorkflowEngineError, WorkflowNotFoundError,
  WorkflowAlreadyRegisteredError, RunNotFoundError,
  StepError, StepTimeoutError,
  WorkflowCanceledError, WorkflowTimeoutError,
  ConsoleLogger, SilentLogger, createScopedLogger,
  generateId, sleep, withRetry, calculateRetryDelay,
  DEFAULT_RETRY_OPTIONS,
} from 'stepflow';
```

Subpath exports are also available:

```typescript
import { ... } from 'stepflow/storage';
import { ... } from 'stepflow/events';
import { ... } from 'stepflow/scheduler';
```

---

## Downstream Integration Patterns

This section documents patterns for integrating Stepflow into application services. The examples below are based on a data synchronization use case but apply to any domain.

### Fastify Plugin Pattern

Wrap Stepflow storage as a Fastify plugin for API-level workflow management:

```typescript
// plugins/stepflow.ts
import fp from 'fastify-plugin';
import { PostgresStorageAdapter, type WorkflowRunRecord, type PaginatedResult } from 'stepflow';

export interface StepflowService {
  storage: PostgresStorageAdapter;

  queueWorkflow(
    kind: string,
    input: Record<string, unknown>,
    options?: { priority?: number; timeoutMs?: number }
  ): Promise<WorkflowRunRecord>;

  getRun(runId: string): Promise<WorkflowRunRecord | undefined>;

  listRuns(options?: {
    kind?: string;
    status?: string | string[];
    limit?: number;
    offset?: number;
  }): Promise<PaginatedResult<WorkflowRunRecord>>;

  cancelRun(runId: string): Promise<void>;
}

export default fp(async (fastify) => {
  const storage = new PostgresStorageAdapter({
    pool: fastify.pg.pool,      // share the app's pool
    schema: 'stepflow',
  });
  await storage.initialize();

  const service: StepflowService = {
    storage,

    async queueWorkflow(kind, input, options = {}) {
      return storage.createRun({
        kind,
        status: 'queued',
        input,
        context: {},
        priority: options.priority ?? 0,
        timeoutMs: options.timeoutMs,
      });
    },

    async getRun(runId) {
      return (await storage.getRun(runId)) ?? undefined;
    },

    async listRuns(options = {}) {
      return storage.listRuns(options);
    },

    async cancelRun(runId) {
      await storage.updateRun(runId, {
        status: 'canceled',
        finishedAt: new Date(),
      });
    },
  };

  fastify.decorate('stepflow', service);

  fastify.addHook('onClose', async () => {
    await storage.close();
  });
});
```

### Worker Service Pattern

A background worker that polls for queued workflows:

```typescript
import { PostgresStorageAdapter } from 'stepflow';

const storage = new PostgresStorageAdapter({
  connectionString: process.env.DATABASE_URL,
  schema: 'stepflow',
});
await storage.initialize();

let currentRunId: string | undefined;
let running = true;

// Poll loop
async function poll() {
  while (running) {
    const run = await storage.dequeueRun(['sync.xero', 'sync.directo']);

    if (run) {
      currentRunId = run.id;
      try {
        await processRun(run);
        await storage.updateRun(run.id, {
          status: 'succeeded',
          output: { /* results */ },
          finishedAt: new Date(),
        });
      } catch (err) {
        await storage.updateRun(run.id, {
          status: 'failed',
          error: { code: 'WORKFLOW_ERROR', message: err.message },
          finishedAt: new Date(),
        });
      } finally {
        currentRunId = undefined;
      }
    }

    await new Promise(r => setTimeout(r, 5000));

    // Periodic stale run cleanup
    await storage.cleanupStaleRuns(600000);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  running = false;
  if (currentRunId) {
    await storage.markRunsAsFailed(
      [currentRunId],
      'Worker process was terminated during workflow execution'
    );
  }
  await storage.close();
  process.exit(0);
});
```

### Step Tracking with saveStepResult

Track granular step progress within a workflow run:

```typescript
async function processRun(run: WorkflowRunRecord) {
  const steps = ['fetch_accounts', 'fetch_contacts', 'fetch_invoices'];

  for (const stepName of steps) {
    const startedAt = new Date();

    await storage.saveStepResult({
      runId: run.id,
      stepName,
      status: 'running',
      attempt: 1,
      startedAt,
    });

    try {
      const result = await executeStep(stepName, run.input);

      await storage.saveStepResult({
        runId: run.id,
        stepName,
        status: 'completed',
        output: { rowsRead: result.read, rowsWritten: result.written },
        attempt: 1,
        startedAt,
        completedAt: new Date(),
      });
    } catch (err) {
      await storage.saveStepResult({
        runId: run.id,
        stepName,
        status: 'failed',
        error: { code: 'STEP_FAILED', message: err.message },
        attempt: 1,
        startedAt,
        completedAt: new Date(),
      });
      throw err;
    }
  }
}
```

### API Routes Pattern

```typescript
// List runs
fastify.get('/api/workflows', async (request) => {
  const { items, total } = await fastify.stepflow.listRuns({ limit: 100 });
  return { data: items, total };
});

// Get run with steps
fastify.get('/api/workflows/:runId', async (request) => {
  const { runId } = request.params;
  const run = await fastify.stepflow.getRun(runId);
  if (!run) return reply.code(404).send({ error: 'Not found' });

  const steps = await fastify.stepflow.storage.getStepResults(runId);
  return { data: { ...run, steps } };
});

// Queue a workflow
fastify.post('/api/workflows/trigger', async (request) => {
  const { kind, input, priority } = request.body;
  const run = await fastify.stepflow.queueWorkflow(kind, input, { priority });
  return { data: { runId: run.id, status: run.status } };
});

// Cancel a workflow
fastify.post('/api/workflows/:runId/cancel', async (request) => {
  await fastify.stepflow.cancelRun(request.params.runId);
  return { data: { message: 'Workflow canceled' } };
});
```
