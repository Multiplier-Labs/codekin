/**
 * StdioTransport — Default transport for Claude Code hooks.
 * Reads JSON from stdin, writes JSON to stdout, errors to stderr.
 */
export class StdioTransport {
  async readInput() {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(`Hook received invalid JSON on stdin: ${err.message}`);
    }
  }

  writeOutput(output) {
    process.stdout.write(JSON.stringify(output));
  }

  writeError(message) {
    process.stderr.write(message);
  }
}
