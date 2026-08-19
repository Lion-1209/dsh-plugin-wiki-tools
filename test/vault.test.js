import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
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
  await assert.rejects(() => vault.trackSource({ sourcePath: '.raw/missing.md' }), /not found/)
})

test('updateIndex preserves an em-dash section style and refreshes in place', async () => {
  const root = await makeVault()
  const vault = new Vault(root)
  await mkdir(join(root, 'wiki'), { recursive: true })
  await writeFile(join(root, 'wiki', 'index.md'), [
    '# Wiki Index',
    '',
    '## Domains',
    '- [[Health]] — 健康管理',
    '- [[Career]] — 职业发展',
    '',
    '## Concepts',
    '- [[Old Idea]]: legacy colon style',
    '',
  ].join('\n'), 'utf8')

  await vault.writePage({ type: 'domain', title: 'Health', content: 'Updated body.', summary: '健康管理与健康记录。' })
  let index = await readFile(join(root, 'wiki', 'index.md'), 'utf8')
  assert.ok(index.includes('- [[Health]] — 健康管理与健康记录。'), 'refresh keeps em-dash style')
  assert.ok(!index.includes(': Updated body.'), 'old colon entry not duplicated')

  await vault.writePage({ type: 'domain', title: 'Learning', content: 'New area.', summary: '学习笔记。' })
  index = await readFile(join(root, 'wiki', 'index.md'), 'utf8')
  assert.ok(index.includes('- [[Learning]] — 学习笔记。'), 'insert follows the section style')

  await vault.writePage({ type: 'concept', title: 'New Idea', content: 'Body.', summary: 'A colon entry.' })
  index = await readFile(join(root, 'wiki', 'index.md'), 'utf8')
  assert.ok(index.includes('- [[New Idea]]: A colon entry.'), 'colon section keeps colon style')
})

test('typeFolders config reroutes pages and validates input', async () => {
  const root = await makeVault()
  const vault = new Vault(root, { typeFolders: { domain: 'wiki/areas' } })
  const { path } = await vault.writePage({ type: 'domain', title: 'Health', content: 'Body.' })
  assert.equal(path, join(root, 'wiki', 'areas', 'Health.md'))
  const index = await readFile(join(root, 'wiki', 'index.md'), 'utf8')
  assert.ok(index.includes('## Areas'), 'index section follows the remapped folder')
  assert.throws(() => new Vault(root, { typeFolders: { unknown: 'wiki/x' } }), /unknown type/)
  assert.throws(() => new Vault(root, { nope: 1 }), /unknown Vault option/)
  assert.throws(() => new Vault(root, { typeFolders: { domain: '../escape' } }), /vault-relative/)
})

test('titles with regex metacharacters match their index entry', async () => {
  const root = await makeVault()
  const vault = new Vault(root)
  const tricky = 'DMA Project A (bss-to-RAM_D1)'
  await vault.writePage({ type: 'concept', title: tricky, content: 'Body one.', summary: 'S1.' })
  await vault.writePage({ type: 'concept', title: tricky, content: 'Body two.', summary: 'S2.' })
  const index = await readFile(join(root, 'wiki', 'index.md'), 'utf8')
  assert.ok(index.includes(`- [[${tricky}]]: S2.`), 'refreshed in place')
  assert.ok(!index.includes('S1.'), 'no stale duplicate entry')
})

test('trackSource normalizes path separators in manifest keys', async () => {
  const root = await makeVault()
  const vault = new Vault(root)
  await writeFile(join(root, '.raw', 'note.md'), 'content', 'utf8')
  await vault.trackSource({ sourcePath: join('.raw', 'note.md') })
  const again = await vault.trackSource({ sourcePath: '.raw/note.md' })
  assert.equal(again.alreadyIngested, true, 'forward and platform separators hit one entry')
  const manifest = JSON.parse(await readFile(join(root, '.raw', '.manifest.json'), 'utf8'))
  assert.deepEqual(Object.keys(manifest.sources), ['.raw/note.md'], 'key stored with forward slashes')
})

test('extraFrontmatter merges schema fields and rejects managed or nested keys', async () => {
  const root = await makeVault()
  const vault = new Vault(root)
  const { path } = await vault.writePage({
    type: 'question',
    title: 'Why Plugin First',
    content: 'Answer body.',
    extraFrontmatter: {
      question: 'Why go plugin-first?',
      answer_quality: 'solid',
      related: ['[[Plugin Architecture]]'],
    },
  })
  const { fields } = splitFrontmatter(await readFile(path, 'utf8'), path)
  assert.equal(fields.question, 'Why go plugin-first?')
  assert.equal(fields.answer_quality, 'solid')
  assert.deepEqual(fields.related, ['[[Plugin Architecture]]'])
  assert.equal(fields.type, 'question')

  await assert.rejects(
    () => vault.writePage({ type: 'concept', title: 'Bad Override', content: 'x', extraFrontmatter: { status: 'evergreen' } }),
    /cannot override managed field "status"/,
  )
  await assert.rejects(
    () => vault.writePage({ type: 'concept', title: 'Bad Nested', content: 'x', extraFrontmatter: { custom: { deep: true } } }),
    /must stay flat/,
  )
})

test('synthesis routes to questions and _index.md is maintained', async () => {
  const root = await makeVault()
  const vault = new Vault(root)
  await vault.writePage({ type: 'synthesis', title: 'Harness Tradeoffs', content: 'Synthesis body.', summary: 'Tradeoff analysis.' })
  const pagePath = join(root, 'wiki', 'questions', 'Harness Tradeoffs.md')
  assert.ok(await readFile(pagePath, 'utf8').then(() => true, () => false), 'synthesis files under questions/')
  const folderIndex = await readFile(join(root, 'wiki', 'questions', '_index.md'), 'utf8')
  assert.ok(folderIndex.includes('- [[Harness Tradeoffs]]: Tradeoff analysis.'), 'folder _index entry created')

  await vault.writePage({ type: 'synthesis', title: 'Harness Tradeoffs', content: 'Updated body.', summary: 'Refreshed.' })
  const refreshed = await readFile(join(root, 'wiki', 'questions', '_index.md'), 'utf8')
  assert.ok(refreshed.includes('- [[Harness Tradeoffs]]: Refreshed.'), 'entry refreshed in place')
  assert.ok(!refreshed.includes('Tradeoff analysis.'), 'no stale duplicate line')
})

test('renamePage rewrites links, swaps indexes, and spares history', async () => {
  const root = await makeVault()
  const vault = new Vault(root)
  await vault.writePage({ type: 'concept', title: 'Old Name', content: 'The concept itself.', summary: 'Old summary.' })
  await vault.writePage({
    type: 'entity',
    title: 'Linker',
    content: 'Links [[Old Name]], alias [[Old Name|the concept]], anchor [[Old Name#section]], and other [[Unrelated Page Name]].',
  })
  await vault.renamePage({ title: 'Old Name', newTitle: 'New Name' })

  const moved = await readFile(join(root, 'wiki', 'concepts', 'New Name.md'), 'utf8')
  assert.ok(moved.includes('title: New Name'), 'frontmatter retitled')
  assert.ok(await readFile(join(root, 'wiki', 'concepts', 'Old Name.md'), 'utf8').then(() => false, () => true), 'old file gone')

  const linker = await readFile(join(root, 'wiki', 'entities', 'Linker.md'), 'utf8')
  assert.ok(linker.includes('[[New Name]]') && linker.includes('[[New Name|the concept]]') && linker.includes('[[New Name#section]]'), 'all link forms rewritten')
  assert.ok(linker.includes('[[Unrelated Page Name]]'), 'prefix-similar titles untouched')

  const index = await readFile(join(root, 'wiki', 'index.md'), 'utf8')
  assert.ok(!index.includes('[[Old Name]]'), 'old index entry removed')
  assert.ok(index.includes('[[New Name]]'), 'new index entry present')
  const folderIndex = await readFile(join(root, 'wiki', 'concepts', '_index.md'), 'utf8')
  assert.ok(folderIndex.includes('[[New Name]]') && !folderIndex.includes('[[Old Name]]'), 'folder index swapped')

  const log = await readFile(join(root, 'wiki', 'log.md'), 'utf8')
  assert.ok(log.includes('] rename | Old Name'), 'rename logged')
  assert.ok(log.includes('[[Old Name]] → [[New Name]]'), 'log keeps the old name as history')

  await assert.rejects(
    () => vault.renamePage({ title: 'New Name', newTitle: 'Linker' }),
    /already exists/,
  )
})

test('vault root validation and wikilink extraction', async () => {
  assert.throws(() => new Vault('relative/path'), /absolute/)
  assert.deepEqual(
    extractWikilinks('See [[Alpha]], [[Beta|alias]], and [[Gamma#heading]]. Ignore ```code [[Fenced]]```'),
    ['Alpha', 'Beta', 'Gamma'],
  )
})

test('archiveSource moves a raw source and drops its manifest entry', async () => {
  const root = await makeVault()
  const vault = new Vault(root)
  await mkdir(join(root, '.raw', 'articles'), { recursive: true })
  await writeFile(join(root, '.raw', 'articles', 'old.md'), 'stale source', 'utf8')
  await vault.trackSource({ sourcePath: '.raw/articles/old.md' })
  const { archivedFrom, archivedTo } = await vault.archiveSource({ sourcePath: '.raw/articles/old.md' })
  assert.equal(archivedFrom, '.raw/articles/old.md')
  assert.equal(archivedTo, '.archive/articles/old.md')
  const moved = await readFile(join(root, '.archive', 'articles', 'old.md'), 'utf8')
  assert.equal(moved, 'stale source')
  const manifest = JSON.parse(await readFile(join(root, '.raw', '.manifest.json'), 'utf8'))
  assert.deepEqual(manifest.sources, {}, 'manifest entry dropped')
  const again = await vault.trackSource({ sourcePath: '.raw/articles/old.md' }).then(() => false, error => error.message)
  assert.match(String(again), /not found/)
  await assert.rejects(() => vault.archiveSource({ sourcePath: 'wiki/index.md' }), /\.raw\/ sources only/)
})

test('a held fresh lock rejects the second writer after retry', async () => {
  const root = await makeVault()
  const holder = new Vault(root, { lockStaleSeconds: 60 })
  const watcher = new Vault(root, { lockStaleSeconds: 60 })
  let release
  const gate = new Promise(resolve => { release = resolve })
  const first = holder.withFileLock('__vault__', async () => gate)
  const locksDir = join(root, '.vault-meta', 'locks')
  for (let attempt = 0; (await readdir(locksDir).catch(() => [])).length === 0; attempt += 1) {
    if (attempt > 100) throw new Error('holder never acquired the lock')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const second = watcher.withFileLock('__vault__', async () => 'should not run')
  await assert.rejects(second, /locked by another writer/)
  release()
  await first
})

test('git auto-commit records each mutation when enabled', async () => {
  const root = await makeVault()
  const { execSync } = await import('node:child_process')
  execSync('git init -q .', { cwd: root })
  execSync('git config user.email test@example.com', { cwd: root })
  execSync('git config user.name test', { cwd: root })
  const vault = new Vault(root, { gitAutoCommit: true })
  await vault.writePage({ type: 'concept', title: 'Committed Concept', content: 'Body.' })
  const log = execSync('git log --oneline', { cwd: root, encoding: 'utf8' }).trim()
  assert.match(log, /wiki: create Committed Concept/)
  await vault.writePage({ type: 'concept', title: 'Committed Concept', content: 'Body v2.' })
  const log2 = execSync('git log --oneline', { cwd: root, encoding: 'utf8' }).trim()
  assert.match(log2.split('\n')[0], /wiki: update Committed Concept/)
})
