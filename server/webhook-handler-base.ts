/**
 * Abstract base class for webhook handlers (GitHub, Stepflow, etc.).
 *
 * Encapsulates the infrastructure that is identical across all webhook-style
 * handlers:
 *   - In-memory event ring buffer (recordEvent / getEvents / getEvent)
 *   - Processing watchdog that marks stuck events as 'error'
 *   - Status update helper
 *   - Graceful shutdown of the watchdog interval
 *
 * Subclasses provide:
 *   - The concrete event type (WebhookEvent, StepflowEvent, …)
 *   - The concrete status type (WebhookEventStatus, StepflowEventStatus, …)
 *   - All domain-specific logic (signature verification, async processing, etc.)
 */

/** Minimum shape every event must satisfy for the base class to operate. */
export interface BaseEvent {
  id: string
  status: string
  receivedAt: string
  error?: string
}

const DEFAULT_MAX_EVENTS = 100

export abstract class WebhookHandlerBase<
  TEvent extends BaseEvent,
  TStatus extends string = string,
> {
  private events: TEvent[] = []
  private _processingWatchdog: ReturnType<typeof setInterval> | null = null
  private maxEventHistory: number

  /**
   * @param logPrefix    Label used in watchdog console output, e.g. `'webhook'` or `'stepflow'`.
   * @param timeoutMs    How long an event may remain in `'processing'` before
   *                     the watchdog marks it as `'error'`.
   * @param maxEventHistory  Maximum number of events stored in the ring buffer.
   */
  constructor(
    private readonly logPrefix: string,
    timeoutMs: number,
    maxEventHistory = DEFAULT_MAX_EVENTS,
  ) {
    this.maxEventHistory = maxEventHistory

    this._processingWatchdog = setInterval(() => {
      const cutoff = Date.now() - timeoutMs
      for (const event of this.events) {
        if (event.status === 'processing' && new Date(event.receivedAt).getTime() < cutoff) {
          console.warn(
            `[${this.logPrefix}] Watchdog: event ${event.id} stuck in 'processing' for >${Math.round(timeoutMs / 60_000)}min, marking error`,
          )
          this.updateEventStatus(event.id, 'error' as TStatus, 'Processing timed out (watchdog)')
        }
      }
    }, 60_000)
    if (this._processingWatchdog.unref) this._processingWatchdog.unref()
  }

  // ---------------------------------------------------------------------------
  // Event ring buffer
  // ---------------------------------------------------------------------------

  /** Append an event to the in-memory ring buffer, trimming the oldest entry when full. */
  protected recordEvent(event: TEvent): void {
    this.events.push(event)
    if (this.events.length > this.maxEventHistory) {
      this.events = this.events.slice(-this.maxEventHistory)
    }
  }

  /** Mutate an event's status in-place. */
  protected updateEventStatus(eventId: string, status: TStatus, error?: string): void {
    const event = this.events.find(e => e.id === eventId)
    if (event) {
      (event as BaseEvent).status = status
      if (error) (event as BaseEvent).error = error
    }
  }

  getEvents(): TEvent[] {
    return [...this.events]
  }

  getEvent(id: string): TEvent | undefined {
    return this.events.find(e => e.id === id)
  }

  // ---------------------------------------------------------------------------
  // Protected helpers for subclasses
  // ---------------------------------------------------------------------------

  /** Return events currently in a given status (useful for concurrency cap checks). */
  protected countByStatus(status: TStatus): number {
    return this.events.filter(e => e.status === status).length
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Stop the processing watchdog interval. Subclasses should call `super.shutdown()`. */
  shutdown(): void {
    if (this._processingWatchdog) {
      clearInterval(this._processingWatchdog)
      this._processingWatchdog = null
    }
  }
}
