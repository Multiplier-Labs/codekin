/**
 * Mark a staging relay's app as such (RELAY_STAGING=1 on the relay, reported
 * by /api/auth/config), so a test deployment is never mistaken for the real
 * one: a fixed badge and a title prefix.
 */

export async function showStagingBadgeIfNeeded(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  let staging = false
  try {
    const res = await fetchImpl('/api/auth/config', { credentials: 'include' })
    if (res.ok) staging = ((await res.json()) as { staging?: unknown }).staging === true
  } catch {
    return false
  }
  if (!staging || document.getElementById('codekin-staging-badge')) return staging
  const badge = document.createElement('div')
  badge.id = 'codekin-staging-badge'
  badge.textContent = 'STAGING'
  badge.setAttribute('role', 'status')
  badge.className =
    'pointer-events-none fixed bottom-2 left-2 z-[70] rounded-control bg-warning-6 px-2 py-0.5 text-micro font-bold tracking-wide text-ink-inverse'
  document.body.appendChild(badge)
  if (!document.title.startsWith('[STAGING]')) document.title = `[STAGING] ${document.title}`
  return true
}
