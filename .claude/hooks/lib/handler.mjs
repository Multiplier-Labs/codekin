/**
 * createHook() — Core entry point for Claude Code hooks.
 *
 * Wires transport, context providers, and handler into the
 * stdin → process → stdout lifecycle.
 *
 * @param {Object} options
 * @param {import('./types.mjs').HookTransport} [options.transport]
 * @param {import('./types.mjs').ContextProvider[]} [options.context]
 * @param {(input: import('./types.mjs').HookInput, ctx: Object) => Promise<import('./types.mjs').HookOutput|void>} options.handler
 */
export async function createHook({ transport, context = [], handler }) {
  const { StdioTransport } = await import('./transport/stdio.mjs');
  const io = transport ?? new StdioTransport();

  try {
    const input = await io.readInput();

    // Gather context from all providers in parallel
    const ctxEntries = await Promise.all(
      context.map(async (p) => [p.name, await p.gather(input)])
    );
    const ctx = Object.fromEntries(ctxEntries);

    const output = await handler(input, ctx);
    if (output) io.writeOutput(output);
  } catch (err) {
    io.writeError(err.message);
    process.exit(2);
  }
}
