import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTools } from '../index.js'
import { Vault } from '../lib/vault.js'

test('createTools returns six schema-complete tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wiki-tools-'))
  await mkdir(join(root, 'wiki'), { recursive: true })
  const tools = createTools(new Vault(root))
  assert.deepEqual(tools.map(tool => tool.name), ['wiki_query', 'wiki_write', 'wiki_rename', 'wiki_scaffold', 'wiki_archive', 'wiki_lint'])
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 40, `${tool.name} has a routing description`)
    assert.ok(tool.parameters.type === 'object', `${tool.name} has object parameters`)
    assert.equal(typeof tool.execute, 'function')
  }
})

test('tool executes run end to end over a fixture vault', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wiki-exec-'))
  await mkdir(join(root, 'wiki'), { recursive: true })
  await mkdir(join(root, '.raw'), { recursive: true })
  await writeFile(join(root, '.raw', 'essay.md'), 'essay body', 'utf8')
  const tools = Object.fromEntries(createTools(new Vault(root)).map(tool => [tool.name, tool]))
  const exec = {}

  const written = await tools.wiki_write.execute({
    title: 'LLM Wiki Pattern',
    type: 'concept',
    content: '# LLM Wiki Pattern\n\nAn LLM maintains a structured wiki from raw sources.',
    source_path: '.raw/essay.md',
  }, exec)
  assert.equal(written.created, true)
  assert.equal(written.alreadyIngested, undefined)

  const skipped = await tools.wiki_write.execute({
    title: 'LLM Wiki Pattern',
    type: 'concept',
    content: '# LLM Wiki Pattern\n\nAn LLM maintains a structured wiki from raw sources.',
    source_path: '.raw/essay.md',
  }, exec)
  assert.equal(skipped.alreadyIngested, true)

  const forced = await tools.wiki_write.execute({
    title: 'LLM Wiki Pattern',
    type: 'concept',
    content: '# LLM Wiki Pattern\n\nAn LLM maintains a structured wiki from raw sources.',
    source_path: '.raw/essay.md',
    force: true,
  }, exec)
  assert.equal(forced.created, false)

  const quick = await tools.wiki_query.execute({ query: 'wiki', mode: 'quick' }, exec)
  assert.equal(quick.mode, 'quick')
  assert.ok(quick.index.includes('LLM Wiki Pattern'))

  const standard = await tools.wiki_query.execute({ query: 'LLM' }, exec)
  assert.equal(standard.results[0].name, 'LLM Wiki Pattern')

  const linted = await tools.wiki_lint.execute({}, exec)
  assert.equal(linted.summary.pagesScanned >= 1, true)
  assert.ok(linted.reportPath.includes('lint-report-'))
})

test('render output carries the full model-facing content, not a summary line', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wiki-render-'))
  await mkdir(join(root, 'wiki'), { recursive: true })
  const tools = Object.fromEntries(createTools(new Vault(root)).map(tool => [tool.name, tool]))
  const exec = {}

  const written = await tools.wiki_write.execute({
    title: 'Render Probe',
    type: 'concept',
    content: '# Render Probe\n\nThe rendering contract requires actual content.',
  }, exec)
  assert.equal(written.created, true)

  const standard = await tools.wiki_query.execute({ query: 'rendering contract' }, exec)
  const standardText = tools.wiki_query.output.render({ query: 'rendering contract' }, standard)[0].text
  assert.ok(standardText.includes('Render Probe'), 'result name in render')
  assert.ok(standardText.includes('The rendering contract requires actual content.'), 'snippet in render')
  assert.ok(standardText.includes('path: '), 'path in render')

  const quick = await tools.wiki_query.execute({ query: 'x', mode: 'quick' }, exec)
  const quickText = tools.wiki_query.output.render({}, quick)[0].text
  assert.ok(quickText.includes(`wiki vault: ${root}`), 'vault root disclosed in render')
  assert.ok(quickText.includes('# Wiki Index'), 'index content in quick render')

  const linted = await tools.wiki_lint.execute({}, exec)
  const lintText = tools.wiki_lint.output.render({}, linted)[0].text
  assert.ok(lintText.includes(`wiki_lint: ${linted.summary.issues} issues`), 'issue count in lint render')
})
