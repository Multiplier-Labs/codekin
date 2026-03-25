import { describe, it, expect, beforeEach } from 'vitest'
import { PlanManager } from './plan-manager.js'

describe('PlanManager', () => {
  let pm: PlanManager

  beforeEach(() => {
    pm = new PlanManager()
  })

  it('starts in idle state', () => {
    expect(pm.state).toBe('idle')
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
    it('transitions planning → reviewing and emits plan_review', () => {
      pm.onEnterPlanMode()
      const reviewEvents: unknown[] = []
      pm.on('plan_review', () => reviewEvents.push('review'))

      pm.onExitPlanModeRequested()

      expect(pm.state).toBe('reviewing')
      expect(reviewEvents).toEqual(['review'])
    })

    it('does nothing when idle (no prior EnterPlanMode)', () => {
      const reviewEvents: unknown[] = []
      pm.on('plan_review', () => reviewEvents.push('review'))

      pm.onExitPlanModeRequested()

      expect(pm.state).toBe('idle')
      expect(reviewEvents).toEqual([])
    })
  })

  describe('approve', () => {
    it('transitions reviewing → idle, emits planning_mode:false and send_message', () => {
      pm.onEnterPlanMode()
      pm.onExitPlanModeRequested()

      const modeEvents: boolean[] = []
      const messages: string[] = []
      pm.on('planning_mode', (active) => modeEvents.push(active))
      pm.on('send_message', (msg) => messages.push(msg))

      pm.approve()

      expect(pm.state).toBe('idle')
      expect(modeEvents).toEqual([false])
      expect(messages).toEqual(['Plan approved. Proceed with implementation.'])
    })

    it('does nothing when not reviewing', () => {
      const modeEvents: boolean[] = []
      pm.on('planning_mode', (active) => modeEvents.push(active))

      pm.approve()

      expect(pm.state).toBe('idle')
      expect(modeEvents).toEqual([])
    })
  })

  describe('deny', () => {
    it('transitions reviewing → planning and emits send_message', () => {
      pm.onEnterPlanMode()
      pm.onExitPlanModeRequested()

      const messages: string[] = []
      pm.on('send_message', (msg) => messages.push(msg))

      pm.deny()

      expect(pm.state).toBe('planning')
      expect(messages).toEqual(['Plan rejected. Please revise the plan and try again.'])
    })

    it('includes user feedback in rejection message', () => {
      pm.onEnterPlanMode()
      pm.onExitPlanModeRequested()

      const messages: string[] = []
      pm.on('send_message', (msg) => messages.push(msg))

      pm.deny('Need more error handling')

      expect(messages).toEqual(['Plan rejected. Please revise: Need more error handling'])
    })

    it('does nothing when not reviewing', () => {
      pm.onEnterPlanMode()

      const messages: string[] = []
      pm.on('send_message', (msg) => messages.push(msg))

      pm.deny()

      expect(pm.state).toBe('planning')
      expect(messages).toEqual([])
    })
  })

  describe('onTurnEnd', () => {
    it('resets reviewing → idle with planning_mode:false (safety net)', () => {
      pm.onEnterPlanMode()
      pm.onExitPlanModeRequested()

      const modeEvents: boolean[] = []
      pm.on('planning_mode', (active) => modeEvents.push(active))

      pm.onTurnEnd()

      expect(pm.state).toBe('idle')
      expect(modeEvents).toEqual([false])
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
      const allMessages: string[] = []
      pm.on('planning_mode', (active) => allModeEvents.push(active))
      pm.on('send_message', (msg) => allMessages.push(msg))

      pm.onEnterPlanMode()
      expect(pm.state).toBe('planning')

      pm.onExitPlanModeRequested()
      expect(pm.state).toBe('reviewing')

      pm.approve()
      expect(pm.state).toBe('idle')

      expect(allModeEvents).toEqual([true, false])
      expect(allMessages).toEqual(['Plan approved. Proceed with implementation.'])
    })

    it('enter → exit request → deny → still planning → exit request → approve', () => {
      const allModeEvents: boolean[] = []
      pm.on('planning_mode', (active) => allModeEvents.push(active))

      pm.onEnterPlanMode()
      pm.onExitPlanModeRequested()
      pm.deny()
      expect(pm.state).toBe('planning')

      pm.onExitPlanModeRequested()
      pm.approve()
      expect(pm.state).toBe('idle')

      expect(allModeEvents).toEqual([true, false])
    })
  })
})
