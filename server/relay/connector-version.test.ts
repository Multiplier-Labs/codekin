/** Tests for connector version floors: the base floor and per-capability floors. */
import { describe, it, expect } from 'vitest'
import { connectorUpdateRequired, hasCapability, CONNECTOR_FLOORS } from './connector-version.js'
import type { ConnectorFloors } from './connector-version.js'

const FLOORS: ConnectorFloors = { base: '0.9.0', capabilities: { intents: '0.12.0' } }

describe('hasCapability', () => {
  it('needs both the claim and a version at or above the floor', () => {
    expect(hasCapability('0.12.0', ['intents'], 'intents', FLOORS)).toBe(true)
    expect(hasCapability('0.13.1-beta.1', ['intents'], 'intents', FLOORS)).toBe(true)
    // A claim below the floor is not believed.
    expect(hasCapability('0.11.9', ['intents'], 'intents', FLOORS)).toBe(false)
    // A new enough connector that doesn't claim it doesn't have it.
    expect(hasCapability('0.12.0', [], 'intents', FLOORS)).toBe(false)
  })

  it('treats a capability without a floor as not shipped', () => {
    expect(hasCapability('9.9.9', ['intents'], 'intents', { base: '0.9.0', capabilities: {} })).toBe(false)
  })
})

describe('connectorUpdateRequired', () => {
  it('passes a connector at or above the base floor', () => {
    expect(connectorUpdateRequired('0.9.0', FLOORS)).toBeNull()
    expect(connectorUpdateRequired('0.10.5', FLOORS)).toBeNull()
  })

  it('refuses a connector below the base floor, or one that cannot say its version', () => {
    expect(connectorUpdateRequired('0.8.9', FLOORS)).toEqual({
      minimum: '0.9.0',
      missing: [],
      reason: 'connector 0.8.9 is older than the minimum 0.9.0',
    })
    expect(connectorUpdateRequired(null, FLOORS)?.minimum).toBe('0.9.0')
    expect(connectorUpdateRequired('garbage', FLOORS)?.minimum).toBe('0.9.0')
  })

  it('ships a floor for signed intents only', () => {
    expect(CONNECTOR_FLOORS.capabilities).toEqual({ intents: '0.11.0' })
    expect(connectorUpdateRequired('0.10.5')).toBeNull()
    expect(hasCapability('0.10.5', ['intents'], 'intents')).toBe(false)
    expect(hasCapability('0.10.6', ['intents'], 'intents')).toBe(false)
    expect(hasCapability('0.11.0', ['intents'], 'intents')).toBe(true)
  })
})
