import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

// CONTEXT.md: the AgentAdapter is the only interface allowed to know which
// agent platform is underneath. This test keeps every other package Claude-free.

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk'
const packagesDir = fileURLToPath(new URL('../..', import.meta.url))

// Walks a package's own sources: prunes node_modules and never follows
// symlinks, which cyclic workspace links would otherwise turn into an
// endless traversal.
function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.name !== 'node_modules')
    .flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return listFiles(path)
      return entry.isFile() ? [path] : []
    })
}

describe('sdk isolation', () => {
  test('only adapter-claude references the Claude Agent SDK', () => {
    const packages = readdirSync(packagesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'adapter-claude')
      .map((entry) => entry.name)
    expect(packages).not.toHaveLength(0)

    const offenders = packages.flatMap((name) =>
      listFiles(join(packagesDir, name)).filter((file) =>
        readFileSync(file, 'utf8').includes(SDK_PACKAGE),
      ),
    )

    expect(offenders).toEqual([])
  })
})
