/**
 * Type-safe JSON.parse wrapper that returns `unknown` instead of `any`.
 *
 * Using this helper avoids `@typescript-eslint/no-unsafe-*` violations that
 * arise from JSON.parse's `any` return type.  Callers are responsible for
 * narrowing the result to the expected shape.
 */
export const jsonParse: (text: string) => unknown = JSON.parse.bind(JSON)
