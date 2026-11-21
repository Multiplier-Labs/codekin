import { describe, it, expect } from 'vitest'
import { checkSchemaSubset, validateAgainstSchema, canonicalJson } from './execution-schema.js'

const proposal = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'confidence', 'folder', 'tags'],
  properties: {
    action: { type: 'string', enum: ['discard', 'archive', 'reply'], description: 'What to do' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    folder: { type: ['string', 'null'] },
    tags: { type: 'array', items: { type: 'string' } },
  },
}

describe('checkSchemaSubset', () => {
  it('accepts strict schemas built from the supported keywords', () => {
    expect(checkSchemaSubset(proposal)).toBeNull()
    expect(checkSchemaSubset({ anyOf: [{ type: 'string' }, { type: 'null' }] })).toBeNull()
  })

  it.each([
    [{ type: 'string', pattern: 'x' }, /unsupported keyword "pattern"/],
    [{ type: 'object', properties: {} }, /additionalProperties: false/],
    [{ type: 'object', additionalProperties: false, properties: { a: { type: 'string' } }, required: [] }, /must list every property/],
    [{ type: 'array' }, /need "items"/],
    [{ type: 'date' }, /unsupported type/],
    [{ $ref: '#/x' }, /unsupported keyword/],
    [{ type: 'string', items: { type: 'string' } }, /items needs type "array"/],
  ])('refuses %j', (schema, message) => {
    expect(checkSchemaSubset(schema)).toMatch(message)
  })
})

describe('validateAgainstSchema', () => {
  const ok = { action: 'archive', confidence: 0.9, folder: null, tags: ['a'] }

  it('accepts a conforming value', () => {
    expect(validateAgainstSchema(proposal, ok)).toBeNull()
  })

  it.each([
    [{ ...ok, action: 'delete' }, /\$\.action: not one of/],
    [{ ...ok, confidence: 2 }, /above maximum/],
    [{ ...ok, folder: 3 }, /\$\.folder: expected string \| null/],
    [{ ...ok, tags: [1] }, /\$\.tags\[0\]/],
    [{ ...ok, extra: true }, /unexpected property "extra"/],
    [{ action: 'archive', confidence: 0.5, folder: null }, /missing property "tags"/],
    [[ok], /expected object/],
  ])('rejects %j', (value, message) => {
    expect(validateAgainstSchema(proposal, value)).toMatch(message)
  })

  it('does not take Object.prototype names for properties', () => {
    const one = { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string' } } }
    expect(validateAgainstSchema(one, JSON.parse('{"a":"x","constructor":1}'))).toMatch(/unexpected property "constructor"/)
    expect(validateAgainstSchema(one, JSON.parse('{"a":"x","__proto__":{"z":1}}'))).toMatch(/unexpected property "__proto__"/)
    const named = { type: 'object', additionalProperties: false, required: ['toString'], properties: { toString: { type: 'string' } } }
    expect(validateAgainstSchema(named, {})).toMatch(/missing property "toString"/)
  })

  it('checks integers and anyOf', () => {
    expect(validateAgainstSchema({ type: 'integer' }, 1.5)).toMatch(/expected integer/)
    expect(validateAgainstSchema({ anyOf: [{ type: 'string' }, { type: 'null' }] }, 3)).toMatch(/anyOf/)
  })
})

describe('canonicalJson', () => {
  it('is independent of key order and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe(canonicalJson({ a: { d: [1, { y: 2, z: 1 }] }, b: 1 }))
  })
})
