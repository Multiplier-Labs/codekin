import { describe, it, expect, beforeEach } from 'vitest'
import { PlanManager } from './plan-manager.js'

describe('PlanManager', () => {
  let pm: PlanManager

  beforeEach(() => {
    pm = new PlanManager()
  })

  it('starts in idle state', () => {
    expect(pm.state).toBe('idle')
    expect(pm.pendingReviewId).toBeNull()
  })

  describe('onEnterPlanMode', () => {
    it('transitions idle → planning and emits planning_mode:true', () => {
      const events: boolean[] = []
      pm.on('planning_mode', (active) => events.push(active))

      pm.onEnterPlanMode()

      expect(pm.state).toBe('planning')
      expect(events).toEqual([true])
    })

    it('is idempotent when already planning', () => {
      const events: boolean[] = []
      pm.onEnterPlanMode()
      pm.on('planning_mode', (active) => events.push(active))

      pm.onEnterPlanMode() // second call

      expect(pm.state).toBe('planning')
      expect(events).toEqual([]) // no duplicate emission
    })
  })

  describe('onExitPlanModeRequested', () => {
    it('transitions planning → reviewing and returns a review ID', () => {
      pm.onEnterPlanMode()

      const reviewId = pm.onExitPlanModeRequested()

      expect(pm.state).toBe('reviewing')
      expect(reviewId).toBeTruthy()
      expect(pm.pendingReviewId).toBe(reviewId)
    })

    it('returns null when idle (no prior EnterPlanMode)', () => {
      const reviewId = pm.onExitPlanModeRequested()

      expect(pm.state).toBe('idle')
      expect(reviewId).toBeNull()
    })

    it('generates unique review IDs per request', () => {
      pm.onEnterPlanMode()
      const id1 = pm.onExitPlanModeRequested()
      pm.deny(id1!) // back to planning

      const id2 = pm.onExitPlanModeRequested()
      expect(id1).not.toBe(id2)
    })
  })

  describe('approve', () => {
    it('transitions reviewing → idle and emits planning_mode:false', () => {
      pm.onEnterPlanMode()
      const reviewId = pm.onExitPlanModeRequested()

      const modeEvents: boolean[] = []
      pm.on('planning_mode', (active) => modeEvents.push(active))

      const result = pm.approve(reviewId!)

      expect(result).toBe(true)
      expect(pm.state).toBe('idle')
      expect(pm.pendingReviewId).toBeNull()
      expect(modeEvents).toEqual([false])
    })

    it('rejects stale review IDs', () => {
      pm.onEnterPlanMode()
      const id1 = pm.onExitPlanModeRequested()
      pm.deny(id1!) // back to planning
      const id2 = pm.onExitPlanModeRequested()

      // Try to approve with the old ID
      const result = pm.approve(id1!)
      expect(result).toBe(false)
      expect(pm.state).toBe('reviewing') // unchanged

      // Approve with the correct ID
      expect(pm.approve(id2!)).toBe(true)
      expect(pm.state).toBe('idle')
    })

    it('does nothing when not reviewing', () => {
      const modeEvents: boolean[] = []
      pm.on('planning_mode', (active) => modeEvents.push(active))

      const result = pm.approve()

      expect(result).toBe(false)
      expect(pm.state).toBe('idle')
      expect(modeEvents).toEqual([])
    })
  })

  describe('deny', () => {
    it('transitions reviewing → planning and returns rejection message', () => {
      pm.onEnterPlanMode()
      const reviewId = pm.onExitPlanModeRequested()

      const msg = pm.deny(reviewId!)

      expect(pm.state).toBe('planning')
      expect(pm.pendingReviewId).toBeNull()
      expect(msg).toBe('Plan rejected. Please revise the plan and try again.')
    })

    it('includes user feedback in rejection message', () => {
      pm.onEnterPlanMode()
      const reviewId = pm.onExitPlanModeRequested()

      const msg = pm.deny(reviewId!, 'Need more error handling')

      expect(msg).toBe('Plan rejected. Please revise: Need more error handling')
    })

    it('returns null when not reviewing', () => {
      pm.onEnterPlanMode()

      const msg = pm.deny()

      expect(pm.state).toBe('planning')
      expect(msg).toBeNull()
    })

    it('rejects stale review IDs', () => {
      pm.onEnterPlanMode()
      pm.onExitPlanModeRequested()

      const msg = pm.deny('wrong-id')
      expect(msg).toBeNull()
      expect(pm.state).toBe('reviewing') // unchanged
    })
  })

  describe('onTurnEnd', () => {
    it('auto-denies reviewing → planning (never auto-approves)', () => {
      pm.onEnterPlanMode()
      pm.onExitPlanModeRequested()

      const modeEvents: boolean[] = []
      pm.on('planning_mode', (active) => modeEvents.push(active))

      pm.onTurnEnd()

      // Should return to planning, NOT idle — never silently approve
      expect(pm.state).toBe('planning')
      expect(pm.pendingReviewId).toBeNull()
      expect(modeEvents).toEqual([]) // no planning_mode:false — still in plan mode
    })

    it('does not change planning state on turn end', () => {
      pm.onEnterPlanMode()

      const modeEvents: boolean[] = []
      pm.on('planning_mode', (active) => modeEvents.push(active))

      pm.onTurnEnd()

      expect(pm.state).toBe('planning')
      expect(modeEvents).toEqual([])
    })

    it('is a no-op when idle', () => {
      const modeEvents: boolean[] = []
      pm.on('planning_mode', (active) => modeEvents.push(active))

      pm.onTurnEnd()

      expect(pm.state).toBe('idle')
      expect(modeEvents).toEqual([])
    })
  })

  describe('reset', () => {
    it('resets planning → idle with planning_mode:false', () => {
      pm.onEnterPlanMode()

      const modeEvents: boolean[] = []
      pm.on('planning_mode', (active) => modeEvents.push(active))

      pm.reset()

      expect(pm.state).toBe('idle')
      expect(modeEvents).toEqual([false])
    })

    it('resets reviewing → idle with planning_mode:false', () => {
      pm.onEnterPlanMode()
      pm.onExitPlanModeRequested()

      const modeEvents: boolean[] = []
      pm.on('planning_mode', (active) => modeEvents.push(active))

      pm.reset()

      expect(pm.state).toBe('idle')
      expect(pm.pendingReviewId).toBeNull()
      expect(modeEvents).toEqual([false])
    })

    it('is a no-op when idle', () => {
      const modeEvents: boolean[] = []
      pm.on('planning_mode', (active) => modeEvents.push(active))

      pm.reset()

      expect(pm.state).toBe('idle')
      expect(modeEvents).toEqual([])
    })
  })

  describe('full lifecycle', () => {
    it('enter → exit request → approve → back to idle', () => {
      const allModeEvents: boolean[] = []
      pm.on('planning_mode', (active) => allModeEvents.push(active))

      pm.onEnterPlanMode()
      expect(pm.state).toBe('planning')

      const reviewId = pm.onExitPlanModeRequested()
      expect(pm.state).toBe('reviewing')

      pm.approve(reviewId!)
      expect(pm.state).toBe('idle')

      expect(allModeEvents).toEqual([true, false])
    })

    it('enter → exit request → deny → still planning → exit request → approve', () => {
      const allModeEvents: boolean[] = []
      pm.on('planning_mode', (active) => allModeEvents.push(active))

      pm.onEnterPlanMode()
      const id1 = pm.onExitPlanModeRequested()
      pm.deny(id1!)
      expect(pm.state).toBe('planning')

      const id2 = pm.onExitPlanModeRequested()
      pm.approve(id2!)
      expect(pm.state).toBe('idle')

      expect(allModeEvents).toEqual([true, false])
    })
  })
})
