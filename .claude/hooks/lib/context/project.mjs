/**
 * ProjectContext — Gathers project metadata from package.json.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export class ProjectContext {
  name = 'project';

  async gather(input) {
    try {
      const pkgPath = join(input.cwd, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      return {
        name: pkg.name,
        hasLint: !!pkg.scripts?.lint,
        hasTest: !!pkg.scripts?.test,
        hasBuild: !!pkg.scripts?.build,
        hasTypecheck: !!pkg.scripts?.typecheck,
        hasDev: !!pkg.scripts?.dev,
      };
    } catch {
      return { name: null, hasLint: false, hasTest: false, hasBuild: false, hasTypecheck: false, hasDev: false };
    }
  }
}
