/**
 * Claude Code Hooks — Type Definitions
 *
 * JSDoc typedefs for the hooks system. These serve as documentation
 * and enable IDE autocomplete without requiring a TypeScript build step.
 */

/**
 * @typedef {'SessionStart'|'SessionEnd'|'UserPromptSubmit'|'PreToolUse'|'PostToolUse'
 *   |'PostToolUseFailure'|'PermissionRequest'|'Notification'|'SubagentStart'
 *   |'SubagentStop'|'Stop'|'TeammateIdle'|'TaskCompleted'|'ConfigChange'
 *   |'PreCompact'|'WorktreeCreate'|'WorktreeRemove'} HookEventName
 */

/**
 * Base shape received on stdin from Claude Code CLI.
 * Event-specific fields are merged at the top level.
 *
 * @typedef {Object} HookInput
 * @property {string} session_id
 * @property {string} transcript_path
 * @property {string} cwd
 * @property {string} permission_mode
 * @property {HookEventName} hook_event_name
 */

/**
 * Output written to stdout (JSON, exit 0).
 *
 * @typedef {Object} HookOutput
 * @property {boolean} [continue]           - false stops Claude entirely
 * @property {string}  [stopReason]         - shown to user when continue=false
 * @property {'block'} [decision]           - blocks the action (PostToolUse, Stop)
 * @property {string}  [reason]             - explanation when decision='block'
 * @property {boolean} [suppressOutput]     - hide stdout from verbose mode
 * @property {string}  [systemMessage]      - warning shown to user
 * @property {Object}  [hookSpecificOutput] - event-specific control fields
 */

/**
 * Pluggable I/O adapter.
 *
 * @typedef {Object} HookTransport
 * @property {() => Promise<HookInput>} readInput
 * @property {(output: HookOutput) => void} writeOutput
 * @property {(message: string) => void} writeError
 */

/**
 * Pluggable context gatherer.
 *
 * @typedef {Object} ContextProvider
 * @property {string} name - key in the context object
 * @property {(input: HookInput) => Promise<Object>} gather
 */

export {};
