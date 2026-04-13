/**
 * Unified process lifecycle coordinator for a single session.
 *
 * Replaces the scattered flag/timer pattern (_restartTimer, _isStarting,
 * _processGeneration, _apiRetry.timer) with a single promise-chain mutex
 * and centralized timer management.
 *
 * Every lifecycle transition (start, stop, reconfigure) is serialized through
 * the mutex so at most one operation is in-flight at a time.  All pending
 * timers (restart, API retry) are cancelled on any new transition.
 */

export interface ProcessCoordinatorDeps {
  /** Spawn the Claude process.  Returns true on success. */
  startProcess(sessionId: string): boolean
  /** Stop the process and wait for it to fully exit. */
  stopProcessAndWait(sessionId: string): Promise<void>
}

export class ProcessCoordinator {
  /** Monotonically increasing counter.  Bumped on every start.  Scheduled
   *  timers capture the generation at schedule time and bail if it changed. */
  private generation = 0
  /** Promise chain that serializes lifecycle operations. */
  private chain: Promise<void> = Promise.resolve()
  /** Active lifecycle timers, keyed by purpose (e.g. 'restart', 'apiRetry'). */
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** True when the user (or idle reaper / delete / shutdown) explicitly stopped
   *  the process.  Prevents scheduled restarts from firing. */
  private _userStopped = false

  constructor(
    private readonly sessionId: string,
    private readonly deps: ProcessCoordinatorDeps,
  ) {}

  // ---------------------------------------------------------------------------
  // Public intent-based API
  // ---------------------------------------------------------------------------

  /**
   * Request a process start.  If another operation is in-flight, waits for it.
   * If the process is already running, the underlying startProcess decides
   * whether to replace it (current behavior: kills old, spawns new).
   */
  requestStart(): Promise<boolean> {
    this._userStopped = false
    return this.enqueue('start', () => this.doStart())
  }

  /**
   * Request a full stop.  Cancels all timers, marks userStopped.
   */
  requestStop(): Promise<void> {
    this._userStopped = true
    this.cancelAllTimers()
    return this.enqueue('stop', () => this.doStop())
  }

  /**
   * Stop the current process, apply a config change, then start a new one.
   * Used by setModel, setProvider, setPermissionMode.
   *
   * @param apply — callback that mutates session config (model, provider, etc.)
   *                before the new process is spawned.
   */
  requestReconfigure(apply: () => void): Promise<boolean> {
    this.cancelAllTimers()
    return this.enqueue('reconfigure', async () => {
      await this.doStop()
      apply()
      this._userStopped = false
      return this.doStart()
    })
  }

  /**
   * Schedule a delayed restart (crash recovery).  The timer is automatically
   * cancelled if any other lifecycle transition happens before it fires.
   *
   * @param onBeforeStart — optional callback invoked after the timer fires but
   *        before startProcess.  Return false to abort the restart.
   * @param onAfterStart — optional callback invoked after startProcess completes
   *        successfully, for post-restart context injection.
   */
  scheduleRestart(delayMs: number, onBeforeStart?: () => boolean, onAfterStart?: () => void): void {
    if (this._userStopped) return
    const gen = this.generation
    this.setTimer('restart', delayMs, () => {
      if (this.generation !== gen || this._userStopped) return
      // Enqueue through the mutex so it doesn't race with other operations
      void this.enqueue('scheduledRestart', async () => {
        // Re-check after acquiring the mutex
        if (this.generation !== gen || this._userStopped) return false
        if (onBeforeStart && !onBeforeStart()) return false
        const started = await this.doStart()
        if (started && onAfterStart) onAfterStart()
        return started
      })
    })
  }

  /**
   * Schedule an API retry.  Tied to the current generation — if the process
   * restarts or stops before the timer fires, the retry is silently dropped.
   */
  scheduleApiRetry(delayMs: number, sendRetry: () => void): void {
    const gen = this.generation
    this.setTimer('apiRetry', delayMs, () => {
      if (this.generation !== gen || this._userStopped) return
      sendRetry()
    })
  }

  /** Cancel a pending API retry timer (e.g. on successful result). */
  cancelApiRetry(): void {
    const timer = this.timers.get('apiRetry')
    if (timer) {
      clearTimeout(timer)
      this.timers.delete('apiRetry')
    }
  }

  /**
   * Cancel all timers and mark as user-stopped.  Used by delete() and
   * shutdown() which handle process killing themselves.
   */
  teardown(): void {
    this._userStopped = true
    this.cancelAllTimers()
  }

  /** Current generation counter. */
  get currentGeneration(): number { return this.generation }

  /** Whether the user has explicitly stopped the process. */
  get isUserStopped(): boolean { return this._userStopped }

  /** Clear the userStopped flag (e.g. when sendInput reactivates an idle-reaped session). */
  clearUserStopped(): void { this._userStopped = false }

  // ---------------------------------------------------------------------------
  // Internal machinery
  // ---------------------------------------------------------------------------

  private enqueue<T>(label: string, op: () => Promise<T | boolean>): Promise<T> {
    this.cancelAllTimers()
    let resolve!: (v: T) => void
    let reject!: (e: unknown) => void
    const result = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    this.chain = this.chain
      .then(() => {
        console.log(`[coordinator] ${this.sessionId} enqueue=${label} gen=${this.generation}`)
        return op().then(resolve as (v: T | boolean) => void, reject)
      })
      .catch((err) => { console.warn(`[coordinator] ${this.sessionId} enqueue=${label} swallowed error:`, err) })
    return result
  }

  private async doStart(): Promise<boolean> {
    this.generation++
    return this.deps.startProcess(this.sessionId)
  }

  private async doStop(): Promise<void> {
    await this.deps.stopProcessAndWait(this.sessionId)
  }

  private setTimer(key: string, delayMs: number, callback: () => void): void {
    const existing = this.timers.get(key)
    if (existing) clearTimeout(existing)
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key)
      callback()
    }, delayMs))
  }

  private cancelAllTimers(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}
