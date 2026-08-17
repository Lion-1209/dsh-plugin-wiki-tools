import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vault, splitFrontmatter, extractWikilinks } from '../lib/vault.js'

async function makeVault() {
  const root = await mkdtemp(join(tmpdir(), 'wiki-vault-'))
  await mkdir(join(root, 'wiki'), { recursive: true })
  await mkdir(join(root, '.raw'), { recursive: true })
  return root
}

test('writePage creates a page with complete frontmatter, index, and log entries', async () => {
  const root = await makeVault()
  const vault = new Vault(root)
  const { path, created } = await vault.writePage({
    type: 'concept',
    title: 'Compounding Vault Pattern',
    content: '# Compounding Vault Pattern\n\nKnowledge compounds like interest.',
    tags: ['pattern'],
  })
  assert.equal(created, true)
  assert.equal(path, join(root, 'wiki', 'concepts', 'Compounding Vault Pattern.md'))

  const raw = await readFile(path, 'utf8')
  const { fields, content } = splitFrontmatter(raw, path)
  assert.equal(fields.type, 'concept')
  assert.equal(fields.title, 'Compounding Vault Pattern')
  assert.equal(fields.status, 'developing')
  assert.match(fields.created, /^\d{4}-\d{2}-\d{2}$/)
  assert.deepEqual(fields.tags, ['pattern'])
  assert.ok(content.includes('# Compounding Vault Pattern'))

  const index = await readFile(join(root, 'wiki', 'index.md'), 'utf8')
  assert.ok(index.includes('## Concepts'))
  assert.ok(index.includes('- [[Compounding Vault Pattern]]: Knowledge compounds like interest.'))

  const log = await readFile(join(root, 'wiki', 'log.md'), 'utf8')
  assert.ok(log.includes('] create | Compounding Vault Pattern'), 'log entry prepended')
})

test('writePage update keeps created and unknown fields, refreshes updated', async () => {
  const root = await makeVault()
  const vault = new Vault(root)
  await vault.writePage({ type: 'entity', title: 'Andrej Karpathy', content: 'First.' })
  const path = join(root, 'wiki', 'entities', 'Andrej Karpathy.md')
  await writeFile(path, (await readFile(path, 'utf8')).replace('status: developing', 'status: solid').replace(/created: .*/, 'created: 2020-01-01'), 'utf8')

  const { created } = await vault.writePage({ type: 'entity', title: 'Andrej Karpathy', content: 'Second.', summary: 'Researcher.' })
  assert.equal(created, false)
  const { fields } = splitFrontmatter(await readFile(path, 'utf8'), path)
  assert.equal(fields.created, '2020-01-01')
  assert.equal(fields.status, 'solid')

  const log = await readFile(join(root, 'wiki', 'log.md'), 'utf8')
  assert.ok(log.includes('] update | Andrej Karpathy'), 'update logged')
  const index = await readFile(join(root, 'wiki', 'index.md'), 'utf8')
  assert.ok(index.includes('- [[Andrej Karpathy]]: Researcher.'), 'index entry refreshed')
})

test('writePage rejects duplicate filenames and malformed titles', async () => {
  const root = await makeVault()
  const vault = new Vault(root)
  await vault.writePage({ type: 'concept', title: 'Duplicate Name', content: 'One.' })
  await assert.rejects(
    vault.writePage({ type: 'entity', title: 'duplicate name', content: 'Two.' }),
    /already exists/,
  )
  await assert.rejects(
    () => vault.writePage({ type: 'concept', title: 'a/b', content: 'x' }),
    /without path separators/,
  )
})

test('trackSource reports delta state across calls', async () => {
  const root = await makeVault()
  const vault = new Vault(root)
  await writeFile(join(root, '.raw', 'article.md'), 'source content v1', 'utf8')
  const first = await vault.trackSource({ sourcePath: '.raw/article.md' })
  assert.equal(first.alreadyIngested, false)
  const second = await vault.trackSource({ sourcePath: '.raw/article.md' })
  assert.equal(second.alreadyIngested, true)
  await writeFile(join(root, '.raw', 'article.md'), 'source content v2', 'utf8')
  const third = await vault.trackSource({ sourcePath: '.raw/article.md' })
  assert.equal(third.alreadyIngested, false)
  await assert.rejects(vault.trackSource({ sourcePath: '.raw/missing.md' }), /not found/)
})

test('vault root validation and wikilink extraction', async () => {
  assert.throws(() => new Vault('relative/path'), /absolute/)
  assert.deepEqual(
    extractWikilinks('See [[Alpha]], [[Beta|alias]], and [[Gamma#heading]]. Ignore ```code [[Fenced]]```'),
    ['Alpha', 'Beta', 'Gamma'],
  )
})
