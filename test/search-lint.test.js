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
    content: '# Karpathy\n\nDescribed the [[Compounding Vault Pattern]] publicly.\n\n## Empty Section\n',
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
  assert.equal(entity.outbound, 1)
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

  assert.ok(checks.includes('dead-link'), 'Renamed Away index link has no page')
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
  const { issues } = await lintVault(root)
  assert.deepEqual(issues, [], 'an indexed page with complete frontmatter is clean')
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
  ].join('\n'), 'utf8')
  const { issues } = await lintVault(root)
  const checks = issues.map(issue => issue.check)
  assert.ok(!checks.includes('duplicate-filename'), 'sibling _index.md files are by design')
  const empties = issues.filter(issue => issue.check === 'empty-section')
  assert.deepEqual(empties.map(issue => issue.detail), ['section "Genuinely Empty" has no content'],
    'a title over subsections is a container; only a sibling-followed empty heading flags')
})
