/** Browser-safe error sanitization. Always redact before any field is shortened. */
const SENSITIVE_KEY = /secret|token|password|cookie|authorization|code|sig|otp|recovery|credential|session/i
/** Machine secrets, device codes, session ids and similar: long base64url runs. */
const LONG_TOKEN = /[A-Za-z0-9_-]{24,}/g
const KEY_VALUE = /\b([A-Za-z0-9_-]*(?:secret|token|password|cookie|authorization|code|sig|otp|recovery|credential|session)[A-Za-z0-9_-]*)(["']?\s*[:=]\s*)(["']?)[^\s"'&,;)}\]]+/gi
const QUERY = /\?[^\s"'#)]+/g
const BEARER = /\b(bearer|basic)\s+\S+/gi

/** Redact credential-shaped content from free text. */
export function scrubText(text: string): string {
  return text
    .replace(BEARER, '$1 [redacted]')
    .replace(KEY_VALUE, '$1$2$3[redacted]')
    .replace(QUERY, '?[redacted]')
    .replace(LONG_TOKEN, '[redacted]')
}

/** Deep-scrub a value: sensitive keys lose their value, every string is scrubbed. */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]'
  if (typeof value === 'string') return scrubText(value)
  if (Array.isArray(value)) return value.map(v => scrubValue(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : scrubValue(v, depth + 1)
    }
    return out
  }
  return value
}

/** Syntax errors can quote arbitrary parsed payloads; omit those messages entirely. */
export function scrubErrorMessage(type: string, message: string): string {
  return type === 'SyntaxError' ? 'Syntax error (message omitted)' : scrubText(message)
}
