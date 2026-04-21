/** Tests for localRepoPath — helper exported from upload-routes. */
import { describe, it, expect } from 'vitest'
import { localRepoPath } from './upload-routes.js'

describe('localRepoPath', () => {
  it('namespaces the repo under its owner', () => {
    expect(localRepoPath('/srv/repos', 'ownerA', 'foo')).toBe('/srv/repos/ownerA/foo')
  })

  it('prevents collision between ownerA/foo and ownerB/foo', () => {
    const a = localRepoPath('/srv/repos', 'ownerA', 'foo')
    const b = localRepoPath('/srv/repos', 'ownerB', 'foo')
    expect(a).not.toBe(b)
  })

  it('works with different reposRoots', () => {
    expect(localRepoPath('/home/user/repos', 'org', 'proj')).toBe('/home/user/repos/org/proj')
  })

  it('handles owner and repo names with hyphens, underscores, and dots', () => {
    expect(localRepoPath('/r', 'my-org', 'my_repo.name')).toBe('/r/my-org/my_repo.name')
  })
})
