/**
 * GitContext — Gathers git repository state.
 * Returns branch, dirty status, and porcelain status output.
 */
import { execSync } from 'node:child_process';

export class GitContext {
  name = 'git';

  async gather(input) {
    const opts = { cwd: input.cwd, encoding: 'utf8', timeout: 5000 };
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', opts).trim();
      const status = execSync('git status --porcelain', opts).trim();
      const dirty = status.length > 0;
      return { branch, dirty, status: status || null };
    } catch {
      return { branch: null, dirty: false, status: null };
    }
  }
}
