import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { quickView, searchVault } from '../lib/search.js'
import { lintVault } from '../lib/lint.js'
import { Vault } from '../lib/vault.js'

async function makeVault() {
  const root = await mkdtemp(join(tmpdir(), 'wiki-search-'))
  await mkdir(join(root, 'wiki'), { recursive: true })
  return root
}

async function seedFixture(root) {
  const vault = new Vault(root)
  await vault.writePage({
    type: 'concept',
    title: 'Compounding Vault Pattern',
    content: '# Compounding\n\nThe vault compounds knowledge across sessions.',
    summary: 'Knowledge compounds like interest.',
  })
  await vault.writePage({
    type: 'entity',
    title: 'Andrej Karpathy',
    content: '# Karpathy\n\nDescribed the [[Compounding Vault Pattern]] publicly and cites [[Missing Collaborator]].\n\n## Empty Section\n',
    summary: 'Researcher; LLM Wiki pattern author.',
  })
  await writeFile(join(root, 'wiki', 'hot.md'), '---\ntype: meta\nupdated: 2020-01-01\n---\n\n# Recent Context\n', 'utf8')
  await writeFile(join(root, 'wiki', 'index.md'), (await readFile(join(root, 'wiki', 'index.md'), 'utf8')).replace('- [[Andrej Karpathy]]', '- [[Renamed Away]]'), 'utf8')
  return vault
}

test('quickView returns the hot cache and master index', async () => {
  const root = await makeVault()
  await seedFixture(root)
  const view = await quickView(root)
  assert.ok(view.hot.includes('# Recent Context'))
  assert.ok(view.index.includes('## Concepts'))
})

test('searchVault ranks title matches above body matches and reports links', async () => {
  const root = await makeVault()
  await seedFixture(root)
  const { results, totalMatches } = await searchVault(root, { query: 'compounding' })
  assert.equal(totalMatches, 2)
  assert.equal(results[0].name, 'Compounding Vault Pattern')
  const entity = results.find(result => result.name === 'Andrej Karpathy')
  assert.ok(entity, 'body match included')
  assert.deepEqual(results[0].inbound, ['Andrej Karpathy'])
  assert.equal(results[0].outbound, 0)
  assert.equal(entity.outbound, 2, 'Karpathy links the concept and the missing collaborator')
  assert.ok(entity.snippets.length > 0)
})

test('inbound links dedupe per source page across repeated wikilinks', async () => {
  const root = await makeVault()
  const vault = new Vault(root)
  await vault.writePage({ type: 'concept', title: 'Repeated Target', content: '# T\n\nTarget.' })
  await vault.writePage({
    type: 'entity',
    title: 'Repeater',
    content: 'Links [[Repeated Target]] twice: [[Repeated Target]].',
  })
  const { results } = await searchVault(root, { query: 'repeated' })
  const target = results.find(result => result.name === 'Repeated Target')
  assert.deepEqual(target.inbound, ['Repeater'], 'one inbound record per source page')
})

test('lintVault flags the seeded issues and writes a report', async () => {
  const root = await makeVault()
  await seedFixture(root)
  const { issues, summary, reportPath } = await lintVault(root)
  const checks = issues.map(issue => issue.check)

  assert.ok(checks.includes('dead-link'), 'Karpathy page links a missing page')
  assert.ok(checks.includes('stale-index-entry'), 'index entry points at renamed page')
  assert.ok(checks.includes('empty-section'), 'Karpathy page has an empty section')
  assert.ok(checks.includes('stale-hot-cache'), 'hot cache older than page updates')
  assert.ok(summary.pagesScanned >= 2)
  assert.ok(reportPath.includes(join('wiki', 'meta', 'lint-report-')))
})

test('lintVault passes a clean vault', async () => {
  const root = await makeVault()
  const vault = new Vault(root)
  await vault.writePage({ type: 'concept', title: 'Solo Concept', content: '# Solo\n\nLinked from nowhere but indexed.' })
  await writeFile(join(root, 'wiki', 'overview.md'), '# Overview\n\nA test vault.\n', 'utf8')
  const { issues } = await lintVault(root)
  assert.deepEqual(issues, [], 'an indexed page with complete frontmatter and structure is clean')
})

test('lintVault reports a missing overview as info', async () => {
  const root = await makeVault()
  const vault = new Vault(root)
  await vault.writePage({ type: 'concept', title: 'Solo Concept', content: '# Solo\n\nIndexed.' })
  const flagged = await lintVault(root)
  const info = flagged.issues.find(issue => issue.check === 'missing-structure')
  assert.ok(info, 'missing overview flagged')
  assert.equal(info.severity, 'info')
  assert.equal(info.page, 'overview')
  await writeFile(join(root, 'wiki', 'overview.md'), '# Overview\n', 'utf8')
  const resolved = await lintVault(root)
  assert.equal(resolved.issues.find(issue => issue.check === 'missing-structure'), undefined, 'info clears once overview exists')
})

test('writePage rejects status values outside the lifecycle vocabulary', async () => {
  const root = await makeVault()
  const vault = new Vault(root)
  await assert.rejects(
    () => vault.writePage({ type: 'concept', title: 'Bad Status', content: 'Body.', status: 'solid' }),
    /status must be one of seed\/developing\/mature\/evergreen/,
  )
  await vault.writePage({ type: 'concept', title: 'Good Status', content: 'Body.', status: 'evergreen' })
  const { issues } = await lintVault(root)
  assert.deepEqual(issues.map(i => i.check).filter(c => c === 'status-vocabulary'), [], 'valid status passes lint')
})

test('lintVault flags status values outside the lifecycle vocabulary', async () => {
  const root = await makeVault()
  const vault = new Vault(root)
  await vault.writePage({ type: 'concept', title: 'Legacy Page', content: 'Body written by an older version.' })
  await mkdir(join(root, 'wiki', 'concepts'), { recursive: true })
  const path = join(root, 'wiki', 'concepts', 'Legacy Page.md')
  let raw = await readFile(path, 'utf8')
  raw = raw.replace('status: developing', 'status: solid')
  await writeFile(path, raw, 'utf8')
  const { issues } = await lintVault(root)
  const flagged = issues.find(issue => issue.check === 'status-vocabulary')
  assert.ok(flagged, 'stray status flagged')
  assert.equal(flagged.page, 'Legacy Page')
  assert.match(flagged.detail, /solid/)
})

test('lintVault exempts _index files and container headings', async () => {
  const root = await makeVault()
  await mkdir(join(root, 'wiki', 'entities'), { recursive: true })
  await mkdir(join(root, 'wiki', 'concepts'), { recursive: true })
  await writeFile(join(root, 'wiki', 'entities', '_index.md'), '---\ntype: meta\n---\n# Entities\n\n- a', 'utf8')
  await writeFile(join(root, 'wiki', 'concepts', '_index.md'), '---\ntype: meta\n---\n# Concepts\n\n- b', 'utf8')
  await writeFile(join(root, 'wiki', 'concepts', 'Container Page.md'), [
    '# Container Page',
    '',
    '## Overview',
    '',
    '### Detail',
    '',
    'Real content here.',
    '',
    '## Genuinely Empty',
    '',
    '## Next',
    '',
    'Also content.',
    '',
    '```sh',
    '# a shell comment that looks like a heading',
    'ls',
    '```',
  ].join('\n'), 'utf8')
  const { issues } = await lintVault(root)
  const checks = issues.map(issue => issue.check)
  assert.ok(!checks.includes('duplicate-filename'), 'sibling _index.md files are by design')
  const empties = issues.filter(issue => issue.check === 'empty-section')
  assert.deepEqual(empties.map(issue => issue.detail), ['section "Genuinely Empty" has no content'],
    'a title over subsections is a container; only a sibling-followed empty heading flags')
})

test('frontmatter aliases resolve links and match queries', async () => {
  const root = await makeVault()
  const vault = new Vault(root)
  await vault.writePage({ type: 'entity', title: 'STM32H7', content: '# STM32H7\n\nMCU family.' })
  await vault.writePage({
    type: 'concept',
    title: 'Alias Quoter',
    content: '# Quoter\n\nThe [[STM32H743]] variant ships more RAM.',
  })
  // Declare the alias after creation, as a real vault would.
  const { readFile, writeFile } = await import('node:fs/promises')
  const page = join(root, 'wiki', 'entities', 'STM32H7.md')
  await writeFile(page, (await readFile(page, 'utf8')).replace('type: entity', 'type: entity\naliases:\n  - STM32H743'), 'utf8')

  const linted = await lintVault(root)
  assert.ok(!linted.issues.some(issue => issue.check === 'dead-link'),
    'a link through a declared alias resolves')

  const { results } = await searchVault(root, { query: 'stm32h743' })
  assert.equal(results[0].name, 'STM32H7', 'query by alias finds the owning page')
})

test('lint reports and inline code are not link-graph sources', async () => {
  const root = await makeVault()
  const vault = new Vault(root)
  await vault.writePage({ type: 'concept', title: 'Real Page', content: '# Real\n\nContent.' })
  await vault.writePage({
    type: 'entity',
    title: 'Quoter',
    content: '# Quoter\n\nExample syntax `[[Not A Link]]` in backticks.',
  })
  const linted = await lintVault(root)
  const dead = linted.issues.filter(issue => issue.check === 'dead-link')
  assert.ok(!dead.some(issue => issue.detail.includes('Not A Link')), 'inline-code wikilinks are not links')

  // A lint report quoting past dead links must not resurrect them as issues.
  await mkdir(join(root, 'wiki', 'meta'), { recursive: true })
  await writeFile(join(root, 'wiki', 'meta', 'lint-report-2026-08-18.md'),
    '---\ntype: meta\n---\n# Lint Report\n\n- links to [[Ghost Page]] which does not exist (recorded)', 'utf8')
  const after = await lintVault(root)
  assert.ok(!after.issues.some(issue => issue.check === 'dead-link' && issue.detail.includes('Ghost Page')),
    'report-recorded links are history, not graph edges')

  const { results } = await searchVault(root, { query: 'Ghost Page' })
  assert.ok(!results.some(result => result.name.startsWith('lint-report')), 'reports are not search hits')
})
