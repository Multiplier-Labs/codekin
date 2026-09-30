/** Tests for @Joe addressing in the session composer. */
import { describe, it, expect } from 'vitest'
import { isAddressedToJoe, parseJoeAddress } from './joeAddress'

describe('parseJoeAddress', () => {
  it('strips a leading @Joe, with or without punctuation', () => {
    expect(parseJoeAddress('@Joe, supervise this fix')).toBe('supervise this fix')
    expect(parseJoeAddress('  @joe: what are you monitoring?')).toBe('what are you monitoring?')
    expect(parseJoeAddress('@Joe')).toBe('')
  })

  it('accepts the configured agent name as well as Joe', () => {
    expect(parseJoeAddress('@Ada run the review weekly', 'Ada')).toBe('run the review weekly')
    expect(parseJoeAddress('@Joe run it', 'Ada')).toBe('run it')
  })

  it('leaves messages for the coding agent alone', () => {
    expect(parseJoeAddress('fix it, then tell @Joe')).toBeNull()
    expect(parseJoeAddress('@Joey please')).toBeNull()
    expect(parseJoeAddress('@joe-bot hi')).toBeNull()
    expect(isAddressedToJoe('/review')).toBe(false)
  })
})
