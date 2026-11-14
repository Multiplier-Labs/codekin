/**
 * Exactly what starting a launch configuration runs: the whole command line,
 * its folder and every environment variable with its value. The file comes
 * from the repository (an agent may have written it), so nothing is cut off.
 */

import type { PreviewLaunchConfig } from '../../types'

export function LaunchCommand({ config }: { config: PreviewLaunchConfig }) {
  if (!config.command) {
    return <div className="font-mono text-meta text-ink-muted">Shows {config.url ?? `localhost:${config.port}`}, a server you run</div>
  }
  const env = Object.entries(config.env ?? {})
  return (
    <div className="font-mono text-meta text-ink-muted">
      <div className="whitespace-pre-wrap break-all text-ink">$ {config.command}</div>
      {config.cwd && <div>in {config.cwd}</div>}
      {env.map(([k, v]) => <div key={k} className="whitespace-pre-wrap break-all">{k}={v}</div>)}
    </div>
  )
}
