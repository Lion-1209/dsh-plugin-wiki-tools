/**
 * Vault-aware search: the wiki-query skill's read order (hot cache, master
 * index, then pages) as one tool-call, plus full-text search with the link
 * graph that makes wiki retrieval different from grep.
 *
 * @module dsh-plugin-wiki-tools/lib/search
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildAliasMap, collectMarkdown, isMachineryPage, resolveLinkTarget } from './vault.js'
import { buildIndex, rank } from './bm25.js'

/**
 * Answer the quick mode: the hot cache and master index verbatim. The caller
 * (the model, following the wiki-query skill) reads these before any page.
 * @param {string} root - absolute vault root.
 * @returns {Promise<{ hot: string | undefined, index: string | undefined }>}
 */
export async function quickView(root) {
  const [hot, index] = await Promise.all([
    readFile(join(root, 'wiki', 'hot.md'), 'utf8').catch(() => undefined),
    readFile(join(root, 'wiki', 'index.md'), 'utf8').catch(() => undefined),
  ])
  return { hot, index }
}

/**
 * Full-text search over the wiki tree with link-graph context. Matches are
 * case-insensitive substrings scored by where they hit: title 5, tags 4,
 * headings 2, body 1 per occurrence.
 * @param {string} root - absolute vault root.
 * @param {object} options - search options.
 * @param {string} options.query - the search text.
 * @param {number} [options.limit=10] - maximum results.
 * @returns {Promise<{ results: { name: string, path: string, score: number, snippets: string[], inbound: string[], outbound: number }[], totalMatches: number }>}
 */
export async function searchVault(root, { query, limit = 10 }) {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) throw new Error('wiki-tools: query must be a non-empty string')
  const pages = await collectMarkdown(join(root, 'wiki'))
  // The link graph covers every file, but results exclude vault machinery:
  // the index matches nearly every term by construction and is already the
  // quick-mode payload, and dated lint reports quote past wikilinks as records,
  // not graph edges — so they neither appear as hits nor count as inbound.
  const searchable = pages.filter(page => !isMachineryPage(page.name))
  const names = new Set(pages.map(page => page.name))
  const aliases = buildAliasMap(pages)
  const inbound = new Map(pages.map(page => [page.name, []]))
  for (const page of searchable) {
    // One inbound record per source page, however many times it links; alias
    // targets resolve to their owning page.
    for (const target of new Set(page.links)) {
      const resolved = resolveLinkTarget(target, names, aliases)
      if (resolved !== undefined) inbound.get(resolved)?.push(page.name)
    }
  }
  // BM25 ranks term overlap (latin words; CJK unigram+bigram); the substring
  // bonuses below keep exact title/alias/tag phrases and partial words ahead,
  // and a substring-only hit still surfaces when tokenization misses it.
  const documents = new Map(searchable.map(page => [
    page.name,
    `${page.name} ${(page.aliases ?? []).join(' ')} ${tagsOf(page)} ${page.content}`,
  ]))
  const bm25Scores = rank(buildIndex(documents), query)

  const results = []
  let totalMatches = 0
  for (const page of searchable) {
    const bm25 = bm25Scores.get(page.name) ?? 0
    const titleHit = page.name.toLowerCase().includes(needle)
      || (page.aliases ?? []).some(alias => alias.toLowerCase().includes(needle))
    const tagHit = tagsOf(page).includes(needle)
    const bodyHit = page.content.toLowerCase().includes(needle)
    if (bm25 === 0 && !titleHit && !tagHit && !bodyHit) continue
    totalMatches += 1
    const score = bm25 + (titleHit ? 5 : 0) + (tagHit ? 4 : 0) + (bodyHit ? 1 : 0)
    results.push({
      name: page.name,
      path: page.path,
      score: Math.round(score * 100) / 100,
      snippets: matchLines(page.content, needle).slice(0, 2),
      inbound: inbound.get(page.name) ?? [],
      outbound: new Set(page.links).size,
    })
  }
  results.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
  return { results: results.slice(0, limit), totalMatches: results.length }
}

/**
 * Case-insensitive matching lines, trimmed for a result snippet.
 * @param {string} content - page body.
 * @param {string} needle - lowercased search text.
 * @returns {string[]} up to 4 matching lines trimmed to 160 characters.
 */
function matchLines(content, needle) {
  const lines = []
  for (const line of content.split('\n')) {
    if (line.toLowerCase().includes(needle)) {
      const trimmed = line.trim()
      lines.push(trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed)
      if (lines.length === 4) break
    }
  }
  return lines
}


/**
 * A page's tags as one lowercase string for matching.
 * @param {{ fields?: Record<string, unknown> }} page - collected page.
 * @returns {string} space-joined tags.
 */
function tagsOf(page) {
  return Array.isArray(page.fields?.tags) ? page.fields.tags.join(' ').toLowerCase() : ''
}
