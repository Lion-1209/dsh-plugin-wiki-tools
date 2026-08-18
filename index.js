/**
 * Wiki Tools — native DeepSeek Harness tools over an Obsidian wiki vault.
 *
 * Registers `wiki_query`, `wiki_write`, and `wiki_lint` on `ctx.tools`,
 * implementing the mechanical core of the wiki skill suite (path routing,
 * frontmatter completion, index/log bookkeeping, source delta tracking, and
 * health checks) so the model spends its turns on synthesis instead of
 * filesystem chores. Vault design follows the LLM Wiki pattern; see
 * dsh-plugin-wiki-skills for the skill half.
 *
 * @module dsh-plugin-wiki-tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { Vault } from './lib/vault.js'
import { quickView, searchVault } from './lib/search.js'
import { lintVault } from './lib/lint.js'

export const name = 'wiki-tools'
export const inject = ['tools']

/** Tool-plugin configuration. */
export const Config = z.object({
  /** Absolute path to the vault root: the directory holding `wiki/` and `.raw/`. */
  vaultPath: z.string().required(),
  /** Maximum pages returned by one wiki_query standard-mode call. */
  maxQueryResults: z.number().default(10),
  /** Per-type folder overrides over the default routing, e.g. `{ domain: "wiki/areas" }`. */
  typeFolders: z.object({
    source: z.string(),
    entity: z.string(),
    concept: z.string(),
    domain: z.string(),
    question: z.string(),
    comparison: z.string(),
    meta: z.string(),
  }).default({}),
})

const PAGE_TYPES = ['source', 'entity', 'concept', 'domain', 'question', 'comparison', 'meta']
const STATUSES = ['seed', 'developing', 'solid']

/**
 * Build the three wiki tool definitions over one vault. Exported for tests.
 * @param {Vault} vault - the configured vault.
 * @param {{ maxQueryResults?: number }} [options] - tool options.
 * @returns {import('@deepseek-ai/dsh-tools').ToolDefinition[]}
 */
export function createTools(vault, options = {}) {
  const limit = options.maxQueryResults ?? 10

  const wikiQuery = defineTool({
    name: 'wiki_query',
    description:
      'Search the knowledge vault. Quick mode returns the hot cache and master index verbatim — '
      + 'read those before opening any page. Standard mode runs full-text search over every wiki page '
      + 'and returns ranked matches with snippets, inbound links, and outbound link counts. '
      + 'Use standard mode when quick context is not enough.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'The search text or question topic.',
      },
      mode: {
        type: 'string',
        enum: ['quick', 'standard'],
        description: 'quick returns hot.md + index.md only (~1500 tokens); standard searches all pages. Defaults to standard.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
      },
      render: (_args, value) => [{
        type: 'text',
        text: typeof value === 'object' && value !== null && 'results' in value
          ? `wiki_query: ${value.results.length} of ${value.totalMatches} matching pages`
          : 'wiki_query: returned hot cache and master index',
      }],
    },
    async execute(args) {
      if (args.mode === 'quick') {
        const view = await quickView(vault.root)
        return { mode: 'quick', ...view }
      }
      const { results, totalMatches } = await searchVault(vault.root, { query: args.query, limit })
      return { mode: 'standard', query: args.query, results, totalMatches }
    },
    presentCall: args => ({ card: 'generic', title: `Query wiki: ${args.query}`, kind: 'read', rawInput: args.query }),
  })

  const wikiWrite = defineTool({
    name: 'wiki_write',
    description:
      'Write or update one wiki page with full bookkeeping: routes the page to its type folder, '
      + 'completes YAML frontmatter (type, title, status, created, updated, tags), guards filename '
      + 'uniqueness, updates the master index entry, and prepends a log entry. The content is the '
      + 'markdown body only — frontmatter is managed. With source_path, records the source hash in '
      + 'the ingest manifest and reports already_ingested for unchanged content unless force is set.',
    parameters: {
      title: {
        type: 'string',
        required: true,
        description: 'Page title; also the filename and [[wikilink]] target. Title Case with spaces.',
      },
      type: {
        type: 'string',
        required: true,
        enum: PAGE_TYPES,
        description: 'Page type, which selects the folder: sources, entities, concepts, domains, questions, comparisons, or meta.',
      },
      content: {
        type: 'string',
        required: true,
        description: 'The markdown body after frontmatter.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Frontmatter tags; defaults to [type].',
      },
      status: {
        type: 'string',
        enum: STATUSES,
        description: 'Frontmatter status; defaults to developing (kept on update).',
      },
      summary: {
        type: 'string',
        description: 'One-line master-index entry; defaults to the first content line.',
      },
      source_path: {
        type: 'string',
        description: 'Vault-relative .raw/ source this page derives from, for delta tracking.',
      },
      force: {
        type: 'boolean',
        description: 'Write even when the source hash is unchanged. Defaults to false.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
      },
      render: (args, value) => [{
        type: 'text',
        text: typeof value === 'object' && value !== null && 'path' in value
          ? `wiki_write: ${value.created ? 'created' : 'updated'} ${value.path}`
          : `wiki_write: skipped ${args.title} (source unchanged)`,
      }],
    },
    async execute(args) {
      if (args.source_path !== undefined) {
        const tracked = await vault.trackSource({
          sourcePath: args.source_path,
          pagesCreated: [args.title],
        })
        if (tracked.alreadyIngested && args.force !== true) {
          return { alreadyIngested: true, hash: tracked.hash, title: args.title }
        }
      }
      return await vault.writePage(args)
    },
    presentCall: args => ({ card: 'generic', title: `Write wiki page: ${args.title}`, kind: 'other', rawInput: { title: args.title, type: args.type } }),
  })

  const wikiLint = defineTool({
    name: 'wiki_lint',
    description:
      'Health-check the knowledge vault: duplicate filenames, dead wikilinks, orphan pages, '
      + 'frontmatter gaps, empty sections, stale index entries, and a stale hot cache. '
      + 'Report only — every issue carries a suggestion. Writes the dated report to wiki/meta/.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
      },
      render: (_args, value) => [{
        type: 'text',
        text: typeof value === 'object' && value !== null && 'summary' in value
          ? `wiki_lint: ${value.summary.issues} issues across ${value.summary.pagesScanned} pages; report at ${value.reportPath ?? '(not written)'}`
          : 'wiki_lint: failed',
      }],
    },
    async execute() {
      return await lintVault(vault.root)
    },
    presentCall: () => ({ card: 'generic', title: 'Lint wiki vault', kind: 'other' }),
  })

  return [wikiQuery, wikiWrite, wikiLint]
}

/**
 * Validate the deployment config and register the three wiki tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx - registrant context carrying the tool registry.
 * @param {import('@deepseek-ai/schemastery').Extract<typeof Config>} config - deployment config with the vault root.
 * @returns {Promise<void>}
 */
export async function apply(ctx, config) {
  if (typeof config.vaultPath !== 'string' || config.vaultPath.length === 0) {
    throw new Error(
      'wiki-tools: config vaultPath is required. Set it on the wiki-tools row from your profile cordis.patch.yml, e.g.\n'
      + '  - id: wiki-tools\n'
      + '    config:\n'
      + '      vaultPath: /absolute/path/to/vault\n'
      + 'The vault is the directory holding wiki/ and .raw/ (scaffold it with the wiki skill first).',
    )
  }
  const vault = new Vault(config.vaultPath, config.typeFolders ?? {})
  await vault.assertRoot()
  for (const tool of createTools(vault, config)) {
    ctx.tools.register(tool)
  }
}
