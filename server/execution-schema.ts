/**
 * JSON-schema subset for execution jobs (docs/EXECUTION-API.md).
 *
 * Jobs ask a harness for structured output, and harnesses enforce schemas in
 * "strict" mode: every object closes its properties (additionalProperties:
 * false) and lists them all in `required`; optional values are expressed as
 * a type union with "null". This module accepts exactly that subset, refuses
 * anything else up front (so a job never silently loses a constraint), and
 * validates outputs against it — the harness's own enforcement is not
 * trusted on its own.
 */

import { createHash } from 'crypto'

export type JsonSchema = Record<string, unknown>

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'anyOf', 'minimum', 'maximum', 'description', 'title'])
const MAX_DEPTH = 12

function typesOf(schema: JsonSchema): string[] {
  const t = schema.type
  if (t === undefined) return []
  return Array.isArray(t) ? t as string[] : [t as string]
}

/**
 * Check that a schema stays inside the supported subset.
 * Returns null when it does, else a message naming the first problem's path.
 */
export function checkSchemaSubset(schema: unknown, path = '$', depth = 0): string | null {
  if (depth > MAX_DEPTH) return `${path}: nested deeper than ${MAX_DEPTH} levels`
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return `${path}: must be an object`
  const s = schema as JsonSchema
  for (const key of Object.keys(s)) {
    if (!KEYWORDS.has(key)) return `${path}: unsupported keyword "${key}"`
  }
  if (s.anyOf !== undefined) {
    if (!Array.isArray(s.anyOf) || s.anyOf.length === 0) return `${path}.anyOf: must be a non-empty array`
    if (s.type !== undefined || s.properties !== undefined || s.items !== undefined) return `${path}: anyOf cannot be combined with type, properties or items`
    for (let i = 0; i < s.anyOf.length; i++) {
      const err = checkSchemaSubset(s.anyOf[i], `${path}.anyOf[${i}]`, depth + 1)
      if (err) return err
    }
    return null
  }
  const types = typesOf(s)
  if (types.length === 0 && s.enum === undefined) return `${path}: needs "type", "enum" or "anyOf"`
  for (const t of types) {
    if (typeof t !== 'string' || !TYPES.has(t)) return `${path}.type: unsupported type ${JSON.stringify(t)}`
  }
  if (s.enum !== undefined) {
    if (!Array.isArray(s.enum) || s.enum.length === 0) return `${path}.enum: must be a non-empty array`
    if (s.enum.some(v => v !== null && typeof v === 'object')) return `${path}.enum: values must be scalars`
  }
  for (const k of ['minimum', 'maximum'] as const) {
    if (s[k] !== undefined && typeof s[k] !== 'number') return `${path}.${k}: must be a number`
  }
  if (types.includes('object')) {
    if (s.additionalProperties !== false) return `${path}: objects must set additionalProperties: false`
    const props = (s.properties ?? {}) as Record<string, unknown>
    if (typeof props !== 'object' || Array.isArray(props)) return `${path}.properties: must be an object`
    const required = s.required ?? []
    if (!Array.isArray(required)) return `${path}.required: must be an array`
    const names = Object.keys(props)
    const missing = names.filter(n => !required.includes(n))
    if (missing.length > 0) return `${path}.required: must list every property (missing ${missing.join(', ')}); use a "null" type union for optional values`
    const unknown = (required as unknown[]).filter(n => typeof n !== 'string' || !names.includes(n))
    if (unknown.length > 0) return `${path}.required: names unknown properties`
    for (const name of names) {
      const err = checkSchemaSubset(props[name], `${path}.properties.${name}`, depth + 1)
      if (err) return err
    }
  } else if (s.properties !== undefined || s.required !== undefined || s.additionalProperties !== undefined) {
    return `${path}: properties/required/additionalProperties need type "object"`
  }
  if (types.includes('array')) {
    if (s.items === undefined) return `${path}: arrays need "items"`
    const err = checkSchemaSubset(s.items, `${path}.items`, depth + 1)
    if (err) return err
  } else if (s.items !== undefined) {
    return `${path}: items needs type "array"`
  }
  return null
}

function typeMatches(t: string, value: unknown): boolean {
  switch (t) {
    case 'null': return value === null
    case 'boolean': return typeof value === 'boolean'
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'array': return Array.isArray(value)
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value)
    default: return false
  }
}

/**
 * Validate a value against a schema already accepted by checkSchemaSubset.
 * Returns the first violation's path and reason, or null when valid.
 */
export function validateAgainstSchema(schema: JsonSchema, value: unknown, path = '$'): string | null {
  if (Array.isArray(schema.anyOf)) {
    for (const sub of schema.anyOf as JsonSchema[]) {
      if (validateAgainstSchema(sub, value, path) === null) return null
    }
    return `${path}: matches no anyOf branch`
  }
  const types = typesOf(schema)
  const matched = types.length === 0 ? null : types.find(t => typeMatches(t, value))
  if (types.length > 0 && !matched) return `${path}: expected ${types.join(' | ')}`
  if (Array.isArray(schema.enum) && !schema.enum.some(v => v === value)) {
    // A null-typed union admits null even when the enum lists only strings.
    if (!(value === null && types.includes('null'))) return `${path}: not one of the allowed values`
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return `${path}: below minimum ${schema.minimum}`
    if (typeof schema.maximum === 'number' && value > schema.maximum) return `${path}: above maximum ${schema.maximum}`
  }
  if (matched === 'object') {
    const obj = value as Record<string, unknown>
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>
    for (const key of Object.keys(obj)) {
      if (!(key in props)) return `${path}: unexpected property "${key}"`
    }
    for (const name of (schema.required ?? []) as string[]) {
      if (!(name in obj)) return `${path}: missing property "${name}"`
    }
    for (const [name, sub] of Object.entries(props)) {
      if (name in obj) {
        const err = validateAgainstSchema(sub, obj[name], `${path}.${name}`)
        if (err) return err
      }
    }
  }
  if (matched === 'array') {
    const items = schema.items as JsonSchema
    const arr = value as unknown[]
    for (let i = 0; i < arr.length; i++) {
      const err = validateAgainstSchema(items, arr[i], `${path}[${i}]`)
      if (err) return err
    }
  }
  return null
}

/** JSON with object keys sorted, so equal requests hash equally regardless of key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).sort().filter(k => obj[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
