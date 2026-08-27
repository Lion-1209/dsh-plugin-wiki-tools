import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vault, splitFrontmatter, extractWikilinks, isMachineryPage } from '../lib/vault.js'

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
  const conceptSection = index.split('## Concepts')[1]?.split('## ')[0] ?? ''
  assert.ok(!conceptSection.includes('[[Old Name]]'), 'old entry removed from Concepts section')
  assert.ok(conceptSection.includes('[[New Name]]'), 'new entry present in Concepts section')
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

test('renamePage spares pages whose titles merely start with the old title', async () => {  const root = await makeVault()
  const vault = new Vault(root)
  await vault.writePage({ type: 'concept', title: 'Agent Harness', content: 'The concept.', summary: 'Concept.' })
  await vault.writePage({ type: 'source', title: 'Agent Harness Comparison Notes', content: 'Source body.', summary: 'Source.' })
  await vault.writePage({
    type: 'entity',
    title: 'Cordis',
    content: 'See [[Agent Harness]] and the source [[Agent Harness Comparison Notes]].',
  })
  await vault.renamePage({ title: 'Agent Harness', newTitle: 'Agent Harness Framework' })

  const linker = await readFile(join(root, 'wiki', 'entities', 'Cordis.md'), 'utf8')
  assert.ok(linker.includes('[[Agent Harness Framework]]'), 'exact link rewritten')
  assert.ok(linker.includes('[[Agent Harness Comparison Notes]]'), 'longer title that starts with the old title untouched')
  assert.ok(!linker.includes('[[Agent Harness Framework Comparison Notes]]'), 'no prefix over-match')

  const source = await readFile(join(root, 'wiki', 'sources', 'Agent Harness Comparison Notes.md'), 'utf8')
  assert.ok(source.includes('title: Agent Harness Comparison Notes'), 'source page keeps its own title')
  const index = await readFile(join(root, 'wiki', 'index.md'), 'utf8')
  assert.ok(index.includes('[[Agent Harness Comparison Notes]]'), 'source index entry intact')
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

test('writePage with source_path registers the manifest and skips unchanged re-ingests', async () => {
  const root = await makeVault()
  const vault = new Vault(root)
  await mkdir(join(root, '.raw', 'articles'), { recursive: true })
  const sourceRel = '.raw/articles/notes.md'
  await writeFile(join(root, '.raw', 'articles', 'notes.md'), 'source body v1', 'utf8')

  const first = await vault.writePage({
    type: 'source', title: 'Notes', content: '# Notes\n\nSummary v1.', sourcePath: sourceRel,
  })
  assert.equal(first.created, true)
  let manifest = JSON.parse(await readFile(join(root, '.raw', '.manifest.json'), 'utf8'))
  assert.ok(manifest.sources[sourceRel], 'entry stored under the normalized forward-slash key')
  assert.equal(manifest.sources[sourceRel].pages_created[0], 'Notes')
  assert.match(manifest.sources[sourceRel].hash, /^[0-9a-f]{64}$/, 'sha256, not a hand-computed md5')

  const second = await vault.writePage({
    type: 'source', title: 'Notes', content: '# Notes\n\nSummary v2.', sourcePath: sourceRel,
  })
  assert.equal(second.alreadyIngested, true)
  const page = await readFile(join(root, 'wiki', 'sources', 'Notes.md'), 'utf8')
  assert.ok(page.includes('Summary v1.'), 'unchanged source leaves the page untouched')

  const forced = await vault.writePage({
    type: 'source', title: 'Notes', content: '# Notes\n\nSummary v2.', sourcePath: sourceRel, force: true,
  })
  assert.equal(forced.created, false)
  const forcedPage = await readFile(join(root, 'wiki', 'sources', 'Notes.md'), 'utf8')
  assert.ok(forcedPage.includes('Summary v2.'), 'force rewrites the page')

  await assert.rejects(
    () => vault.writePage({ type: 'source', title: 'Elsewhere', content: 'x', sourcePath: 'wiki/index.md' }),
    /source_path must be a vault-relative path under \.raw\//,
  )
})

test('manifest keys written with backslashes still match on track and archive', async () => {  const root = await makeVault()
  const vault = new Vault(root)
  await mkdir(join(root, '.raw', 'articles'), { recursive: true })
  await writeFile(join(root, '.raw', 'articles', 'twin.md'), 'twin body', 'utf8')
  // Hand-written entry, Windows separators (what model-era manual edits produced).
  await writeFile(join(root, '.raw', '.manifest.json'), JSON.stringify({
    sources: { '.raw\\articles\\twin.md': { hash: '0'.repeat(64), ingested_at: '2026-01-01', pages_created: [], pages_updated: [] } },
  }, null, 2), 'utf8')

  await vault.trackSource({ sourcePath: '.raw/articles/twin.md', pagesCreated: ['Twin'] })
  const manifest = JSON.parse(await readFile(join(root, '.raw', '.manifest.json'), 'utf8'))
  assert.deepEqual(Object.keys(manifest.sources), ['.raw/articles/twin.md'], 'backslash twin replaced by the normalized key')

  await vault.archiveSource({ sourcePath: '.raw/articles/twin.md' })
  const emptied = JSON.parse(await readFile(join(root, '.raw', '.manifest.json'), 'utf8'))
  assert.deepEqual(emptied.sources, {}, 'archive removes the entry regardless of stored separator style')
})

test('writePage reports unresolved wikilinks instead of writing them silently', async () => {
  const root = await makeVault()
  const vault = new Vault(root)
  await vault.writePage({ type: 'entity', title: 'Real Entity', content: 'Exists.' })
  const result = await vault.writePage({
    type: 'concept',
    title: 'Linking Concept',
    content: 'Links [[Real Entity]] and [[Ghost Page]] and [[Real Entity]] again.',
  })
  assert.deepEqual(result.unresolvedLinks, ['Ghost Page'], 'only the unknown target is reported, deduped')
  const clean = await vault.writePage({
    type: 'concept', title: 'Clean Concept', content: 'Links [[Real Entity]] only.',
  })
  assert.equal(clean.unresolvedLinks, undefined, 'fully-resolved pages carry no note')
})

test('renamePage refreshes updated on pages whose links it rewrote', async () => {
  const root = await makeVault()
  const vault = new Vault(root)
  await vault.writePage({ type: 'concept', title: 'Old Title', content: 'Body.' })
  await vault.writePage({ type: 'entity', title: 'Linker', content: 'Points at [[Old Title]].' })
  const stale = '2020-01-01'
  const linkerPath = join(root, 'wiki', 'entities', 'Linker.md')
  await writeFile(linkerPath, (await readFile(linkerPath, 'utf8')).replace(/^(updated:).+$/m, `$1 ${stale}`), 'utf8')
  await vault.renamePage({ title: 'Old Title', newTitle: 'New Title' })
  const rewritten = await readFile(linkerPath, 'utf8')
  assert.ok(rewritten.includes('[[New Title]]'), 'link rewritten')
  assert.match(rewritten, /^updated: \d{4}-\d{2}-\d{2}$/m, 'updated stamp present')
  assert.ok(!rewritten.includes(`updated: ${stale}`), 'stale stamp replaced by today')
})

test('renamePage refuses vault machinery whatever the casing', async () => {
  const root = await makeVault()
  const vault = new Vault(root)
  await vault.writePage({ type: 'concept', title: 'Filler', content: 'x.' })
  await vault.writePage({ type: 'meta', title: 'Lint Report 2026-08-19', content: 'retitled report' })
  await assert.rejects(
    () => vault.renamePage({ title: 'Lint Report 2026-08-19', newTitle: 'Report Renamed' }),
    /machinery/,
  )
  await assert.rejects(() => vault.renamePage({ title: 'log', newTitle: 'History' }), /machinery/)
  for (const name of ['lint-report-2026-08-19', 'Lint Report 2026-08-19', 'LINT REPORT x', 'log', 'LOG', 'Index', '_index', 'hot', 'Overview']) {
    assert.ok(isMachineryPage(name), `machinery detection covers ${name}`)
  }
  assert.ok(!isMachineryPage('Lint Reporter Profile'), 'similar-looking content name is not machinery')
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

test('git auto-commit keeps advisory lock files out of history', async () => {
  const root = await makeVault()
  const { execSync } = await import('node:child_process')
  execSync('git init -q .', { cwd: root })
  execSync('git config user.email test@example.com', { cwd: root })
  execSync('git config user.name test', { cwd: root })
  const vault = new Vault(root, { gitAutoCommit: true })
  await vault.withFileLock('test-op', async () => {
    await vault.writePage({ type: 'concept', title: 'Locked Write', content: 'Body.' })
  })
  const tracked = execSync('git ls-files .vault-meta', { cwd: root, encoding: 'utf8' }).trim()
  assert.equal(tracked, '', 'no lock file tracked under .vault-meta')
  const gitignore = await readFile(join(root, '.gitignore'), 'utf8')
  assert.ok(gitignore.includes('.vault-meta/locks/'), 'vault .gitignore names the lock directory')
  const status = execSync('git status --porcelain .vault-meta', { cwd: root, encoding: 'utf8' }).trim()
  assert.equal(status, '', 'lock files neither tracked nor pending')
})
