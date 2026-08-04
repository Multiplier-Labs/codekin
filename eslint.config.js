import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'server/dist', 'server/vitest.config.ts', 'vitest.config.ts', 'workflows', '.claude/worktrees/**']),
  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}', 'server/**'],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Demote pervasive pre-existing patterns to warnings for incremental adoption.
      // These should be promoted to errors as the codebase is cleaned up.
      '@typescript-eslint/restrict-template-expressions': ['warn', { allowNumber: true }],
      '@typescript-eslint/no-confusing-void-expression': 'warn',
      '@typescript-eslint/no-unnecessary-condition': 'warn',
      '@typescript-eslint/no-base-to-string': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-misused-promises': 'warn',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'warn',
      '@typescript-eslint/require-await': 'warn',
      '@typescript-eslint/no-redundant-type-constituents': 'error',
      '@typescript-eslint/no-dynamic-delete': 'error',
      '@typescript-eslint/no-deprecated': 'error',
    },
  },
  {
    // Styling guard: components must use the semantic tokens (bg-page,
    // bg-surface, border-edge, text-ink-muted, ...) or the intent families
    // (primary/secondary/accent/error/warning/success) — never raw neutral
    // scale steps or Tailwind's default palette. See "Styling rules" in
    // CLAUDE.md and the semantic aliases in src/index.css.
    files: ['src/components/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/\\b(bg|text|border|divide|ring|placeholder|from|to|via)-neutral-\\d/]',
          message: 'Use semantic tokens (bg-page/bg-surface/bg-surface-raised, border-edge, text-ink…) instead of raw neutral scale steps.',
        },
        {
          selector: 'TemplateElement[value.raw=/\\b(bg|text|border|divide|ring|placeholder|from|to|via)-neutral-\\d/]',
          message: 'Use semantic tokens (bg-page/bg-surface/bg-surface-raised, border-edge, text-ink…) instead of raw neutral scale steps.',
        },
        {
          selector: 'Literal[value=/\\b(bg|text|border)-(purple|red|blue|green|gray|grey|slate|zinc|stone|amber|yellow|emerald|teal|cyan|sky|orange|pink|rose|indigo|violet|fuchsia|lime)-\\d{3}|\\btext-white\\b|\\bbg-white\\b/]',
          message: "Tailwind's default palette is off-system: use the intent families (secondary, error, …) or text-ink-inverse.",
        },
        {
          selector: 'TemplateElement[value.raw=/\\b(bg|text|border)-(purple|red|blue|green|gray|grey|slate|zinc|stone|amber|yellow|emerald|teal|cyan|sky|orange|pink|rose|indigo|violet|fuchsia|lime)-\\d{3}|\\btext-white\\b|\\bbg-white\\b/]',
          message: "Tailwind's default palette is off-system: use the intent families (secondary, error, …) or text-ink-inverse.",
        },
      ],
    },
  },
  {
    files: ['server/**/*.ts'],
    ignores: ['server/**/*.test.ts'],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['warn', { allowNumber: true }],
      '@typescript-eslint/no-confusing-void-expression': 'warn',
      '@typescript-eslint/no-unnecessary-condition': 'warn',
      '@typescript-eslint/no-base-to-string': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-misused-promises': 'warn',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'warn',
      '@typescript-eslint/require-await': 'warn',
      '@typescript-eslint/no-redundant-type-constituents': 'error',
      '@typescript-eslint/no-dynamic-delete': 'error',
      '@typescript-eslint/no-deprecated': 'error',
    },
  },
  {
    files: ['**/*.test.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      // `require()` is needed inside `vi.hoisted(...)` blocks because regular
      // ESM imports are not available at hoist-evaluation time.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
])
