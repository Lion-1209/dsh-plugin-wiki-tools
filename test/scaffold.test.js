import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scaffoldVault } from '../lib/scaffold.js'
import { Vault } from '../lib/vault.js'
import { lintVault } from '../lib/lint.js'

test('generic scaffold creates the full structure and is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scaffold-generic-'))
  const first = await scaffoldVault(root, { mode: 'generic', purpose: 'dsh plugin testing' })
  assert.ok(first.created.includes('wiki/index.md'))
  assert.ok(first.created.includes('wiki/hot.md'))
  assert.ok(first.created.includes('wiki/overview.md'))
  assert.ok(first.created.includes('wiki/sources/_index.md'))
  assert.ok(first.created.includes('AGENTS.md'))
  assert.deepEqual(first.suggestedTypeFolders, {})

  const agents = await readFile(join(root, 'AGENTS.md'), 'utf8')
  assert.ok(agents.includes('wiki_query, wiki_write, wiki_rename, wiki_lint'), 'conventions name the tools')
  assert.ok(agents.includes('Purpose: dsh plugin testing'))

  const second = await scaffoldVault(root, { mode: 'generic', purpose: 'dsh plugin testing' })
  assert.deepEqual(second.created, [], 'nothing recreated')
  assert.deepEqual(second.skipped.sort(), first.created.sort(), 'everything reported as existing')

  // The scaffolded generic vault lints clean and accepts wiki_write directly.
  const vault = new Vault(root)
  await vault.writePage({ type: 'concept', title: 'Scaffolded Concept', content: 'Written after scaffold.' })
  const linted = await lintVault(root)
  assert.equal(linted.summary.issues, 0)
})

test('research scaffold creates mode folders, stubs, and a typeFolders suggestion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scaffold-research-'))
  const result = await scaffoldVault(root, { mode: 'research', purpose: 'agent harness studies' })
  assert.ok(result.created.includes('wiki/papers/_index.md'))
  assert.ok(result.created.includes('wiki/thesis/Research Overview.md'))
  assert.ok(result.created.includes('wiki/gaps/Open Questions.md'))
  assert.deepEqual(result.suggestedTypeFolders, {
    source: 'wiki/papers',
    question: 'wiki/gaps',
    concept: 'wiki/concepts',
  })

  const stub = await readFile(join(root, 'wiki/thesis', 'Research Overview.md'), 'utf8')
  assert.ok(stub.includes('type: thesis') && stub.includes('status: seed'), 'mode-typed seed page')
  const overview = await readFile(join(root, 'wiki/overview.md'), 'utf8')
  assert.ok(overview.includes('agent harness studies'), 'purpose lands in overview')
})

test('unknown scaffold modes fail loud', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scaffold-bad-'))
  await assert.rejects(
    () => scaffoldVault(root, { mode: 'vibes' }),
    /unknown scaffold mode "vibes"/,
  )
})
