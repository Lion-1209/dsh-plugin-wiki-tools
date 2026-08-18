/**
 * Vault bookkeeping: path routing, frontmatter completion, index/log updates,
 * and source delta tracking for an Obsidian wiki vault following the LLM Wiki
 * layout (`.raw/` sources, `wiki/` knowledge tree).
 *
 * The vault is host-local user data addressed by an explicitly configured
 * absolute root; reads and writes go through node:fs directly, not a dsh
 * filesystem seam, because the vault lives outside any session workspace by
 * design (cross-project referencing is the point).
 *
 * @module dsh-plugin-wiki-tools/lib/vault
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/** Page-type to vault folder routing (the suite's generic mode). */
export const TYPE_FOLDERS = {
  source: 'wiki/sources',
  entity: 'wiki/entities',
  concept: 'wiki/concepts',
  domain: 'wiki/domains',
  question: 'wiki/questions',
  comparison: 'wiki/comparisons',
  meta: 'wiki/meta',
}

/** Master-index section headings follow the mapped folder basename, computed per vault. */

/**
 * Capitalize a folder basename for an index section heading.
 * @param {string} value - lowercase folder basename.
 * @returns {string} the capitalized heading title.
 */
function capitalize(value) {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1)
}

/** Pages that are vault machinery, never linted as content (basenames, no extension). */
export const META_FILENAMES = new Set(['index', '_index', 'log', 'hot', 'overview'])

/**
 * Split one Markdown file into frontmatter fields and body. A file without a
 * frontmatter fence returns no fields; a broken fence throws.
 * @param {string} raw - the complete file text.
 * @param {string} source - path shown in error messages.
 * @returns {{ fields: Record<string, unknown> | undefined, content: string }}
 */
export function splitFrontmatter(raw, source) {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) return { fields: undefined, content: raw }
  const firstLineEnd = raw.indexOf('\n')
  const rest = raw.slice(firstLineEnd + 1)
  const closing = rest.search(/^---(?:\r?\n|$)/m)
  if (closing < 0) throw new Error(`${source}: frontmatter has no closing --- fence`)
  const frontmatterText = rest.slice(0, closing)
  const content = rest.slice(closing).replace(/^---\r?\n?/, '')
  const fields = parseYaml(frontmatterText)
  if (fields !== null && typeof fields !== 'object' && !Array.isArray(fields)) {
    throw new Error(`${source}: frontmatter must be a YAML mapping`)
  }
  return { fields: fields === null ? undefined : fields, content }
}

/** Today as the vault's canonical YYYY-MM-DD stamp. */
export function today() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * One vault root. All bookkeeping mutations go through {@link Vault.writePage},
 * which completes frontmatter, updates the master index, and prepends a log
 * entry in one serialized write per file.
 */
export class Vault {
  /**
   * @param {string} root - absolute path to the vault root (the directory holding `wiki/` and `.raw/`).
   * @param {Record<string, string>} [typeFolders] - per-type folder overrides over {@link TYPE_FOLDERS}
   *   (e.g. `{ domain: 'wiki/areas' }` for a vault whose top-level topics live in `areas/`).
   */
  constructor(root, typeFolders = {}) {
    if (typeof root !== 'string' || root.length === 0 || !isAbsolute(root)) {
      throw new Error(`wiki-tools: vaultPath must be an absolute directory path (got ${JSON.stringify(root)})`)
    }
    this.root = root
    this.typeFolders = { ...TYPE_FOLDERS }
    for (const [type, folder] of Object.entries(typeFolders)) {
      if (!(type in this.typeFolders)) {
        throw new Error(`wiki-tools: typeFolders config names unknown type "${type}"`)
      }
      if (typeof folder !== 'string' || folder.length === 0 || folder.includes('..')) {
        throw new Error(`wiki-tools: typeFolders.${type} must be a non-empty vault-relative folder path`)
      }
      this.typeFolders[type] = folder
    }
    /** Index section heading per type, following the effective folder layout. */
    this.indexSections = Object.fromEntries(
      Object.keys(TYPE_FOLDERS).map(type => [type, `## ${capitalize(basename(this.typeFolders[type]))}`]),
    )
    /** Per-file write chains so concurrent tool calls serialize per target. */
    this.writeChains = new Map()
  }

  /** Absolute path of one routed page. @param {string} type - page type. @param {string} title - page title (also the filename). */
  pagePath(type, title) {
    const folder = this.typeFolders[type]
    if (folder === undefined) throw new Error(`wiki-tools: unknown page type "${type}"`)
    if (!/^[^/\\]+(\.md)?$/.test(title) || title.includes('\n')) {
      throw new Error(`wiki-tools: title must be a plain filename without path separators (got ${JSON.stringify(title)})`)
    }
    const filename = title.endsWith('.md') ? title : `${title}.md`
    return join(this.root, folder, filename)
  }

  /**
   * Verify the vault root exists and is a directory.
   * @returns {Promise<void>} rejects with a setup hint when the root is missing.
   */
  async assertRoot() {
    const info = await stat(this.root).catch(error => {
      if (error.code === 'ENOENT') {
        throw new Error(`wiki-tools: vault root ${this.root} does not exist; scaffold it first (the wiki skill's SCAFFOLD operation), then point vaultPath at it`)
      }
      throw error
    })
    if (!info.isDirectory()) throw new Error(`wiki-tools: vault root ${this.root} is not a directory`)
  }

  /**
   * Read one page's frontmatter and body.
   * @param {string} path - absolute page path.
   * @returns {Promise<{ fields: Record<string, unknown> | undefined, content: string } | undefined>} undefined when missing.
   */
  async readPage(path) {
    let raw
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
    return splitFrontmatter(raw, path)
  }

  /**
   * Serialize one mutating operation per target path.
   * @param {string} path - absolute target path.
   * @param {() => Promise<T>} operation - the mutation, run after the previous one settles.
   * @returns {Promise<T>}
   */
  enqueue(path, operation) {
    const previous = this.writeChains.get(path) ?? Promise.resolve()
    const next = previous.then(operation, operation)
    this.writeChains.set(path, next.then(() => {}, () => {}))
    return next
  }

  /**
   * Write one wiki page with complete bookkeeping: frontmatter completion,
   * filename-uniqueness guard, master-index entry, and a log entry. Existing
   * pages keep `created` and any unknown frontmatter fields; `updated` moves
   * to today.
   * @param {object} input - the write request.
   * @param {string} input.type - page type (routed to a folder).
   * @param {string} input.title - page title; also the filename and wikilink target.
   * @param {string} input.content - markdown body after frontmatter.
   * @param {string[]} [input.tags] - frontmatter tags; defaults to `[type]`.
   * @param {string} [input.status] - frontmatter status; defaults to `developing` on create.
   * @param {string} [input.summary] - one-line index entry; defaults to the first content line.
   * @returns {Promise<{ path: string, created: boolean, title: string }>}
   */
  async writePage({ type, title, content, tags, status, summary }) {
    const path = this.pagePath(type, title)
    return await this.enqueue(path, async () => {
      await this.assertRoot()
      const cleanTitle = title.endsWith('.md') ? title.slice(0, -3) : title
      const existing = await this.readPage(path)
      await this.assertUniqueFilename(cleanTitle, path)
      const date = today()
      const fields = {
        ...(existing?.fields ?? {}),
        type,
        title: cleanTitle,
        status: status ?? existing?.fields?.status ?? 'developing',
        created: existing?.fields?.created ?? date,
        updated: date,
        tags: tags ?? existing?.fields?.tags ?? [type],
      }
      const file = `---\n${stringifyYaml(fields).trimEnd()}\n---\n\n${content.replace(/^\s*\n/, '')}\n`
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, file, 'utf8')
      await this.updateIndex(type, cleanTitle, summary ?? firstContentLine(content))
      await this.prependLog(`## [${date}] ${existing === undefined ? 'create' : 'update'} | ${cleanTitle}`, [
        `- ${existing === undefined ? 'Created' : 'Updated'}: [[${cleanTitle}]]`,
      ])
      return { path, created: existing === undefined, title: cleanTitle }
    })
  }

  /**
   * Reject a title whose filename already exists elsewhere in the tree:
   * wikilinks address pages by bare filename, so duplicates break resolution.
   * @param {string} title - page title being written.
   * @param {string} path - the routed destination path.
   */
  async assertUniqueFilename(title, path) {
    const pages = await collectMarkdown(join(this.root, 'wiki'))
    for (const page of pages) {
      if (page.name.toLowerCase() === title.toLowerCase() && page.path !== path) {
        throw new Error(`wiki-tools: filename "${title}.md" already exists at ${page.path}; wikilinks need unique filenames`)
      }
    }
  }

  /**
   * Add or refresh one `[[Title]]` entry in the master index. Missing sections
   * and files are created on first use. Existing entries are matched regardless
   * of separator (`: ` or ` — `) and rewritten in the section's dominant style,
   * so vaults using em-dash indexes stay consistent.
   * @param {string} type - page type selecting the index section.
   * @param {string} title - page title.
   * @param {string} summary - one-line description.
   */
  async updateIndex(type, title, summary) {
    const heading = this.indexSections[type]
    if (heading === undefined) return
    const indexPath = join(this.root, 'wiki', 'index.md')
    let raw = await readFile(indexPath, 'utf8').catch(() => undefined)
    if (raw === undefined) {
      raw = '# Wiki Index\n\n'
      for (const section of Object.values(this.indexSections)) raw += `${section}\n\n`
      await mkdir(join(indexPath, '..'), { recursive: true })
    }
    const lines = raw.split('\n')
    let headingLine = lines.findIndex(line => line === heading)
    if (headingLine < 0) {
      lines.push('', heading, `- [[${title}]]: ${summary.replace(/\n/g, ' ')}`)
      await writeFile(indexPath, `${lines.join('\n')}\n`, 'utf8')
      return
    }
    let end = headingLine + 1
    while (end < lines.length && lines[end] !== '' && !lines[end].startsWith('## ')) end += 1
    const section = lines.slice(headingLine + 1, end)
    const entryPattern = new RegExp(`^\\s*-?\\s*\\[\\[${escapeRegExp(title)}\\]\\]`)
    const at = section.findIndex(line => entryPattern.test(line))
    const separator = indexSeparator(section, at >= 0 ? section[at] : undefined)
    const entry = `- [[${title}]]${separator} ${summary.replace(/\n/g, ' ')}`
    if (at >= 0) {
      lines[headingLine + 1 + at] = entry
    } else {
      lines.splice(end, 0, entry)
    }
    await writeFile(indexPath, `${lines.join('\n')}\n`, 'utf8')
  }

  /**
   * Prepend one dated entry to the append-only operation log.
   * @param {string} header - the `## [date] op | title` heading line.
   * @param {string[]} bullets - detail lines under the heading.
   */
  async prependLog(header, bullets) {
    const logPath = join(this.root, 'wiki', 'log.md')
    const raw = await readFile(logPath, 'utf8').catch(() => '# Wiki Log\n')
    const stripped = raw.replace(/^# Wiki Log\r?\n?/, '')
    const entry = `${header}\n${bullets.join('\n')}\n\n`
    await mkdir(join(logPath, '..'), { recursive: true })
    await writeFile(logPath, `# Wiki Log\n\n${entry}${stripped.replace(/^\s*/, '')}`, 'utf8')
  }

  /**
   * Delta-track one raw source: report whether its content hash is unchanged
   * since the last ingest, then record the new hash and touched pages.
   * @param {object} input - the tracking request.
   * @param {string} input.sourcePath - vault-relative or absolute `.raw/` source path.
   * @param {string[]} [input.pagesCreated] - pages this ingest created.
   * @param {string[]} [input.pagesUpdated] - pages this ingest updated.
   * @returns {Promise<{ hash: string, alreadyIngested: boolean }>}
   */
  async trackSource({ sourcePath, pagesCreated = [], pagesUpdated = [] }) {
    const absolute = isAbsolute(sourcePath) ? sourcePath : join(this.root, sourcePath)
    const rel = relative(this.root, absolute)
    const raw = await readFile(absolute).catch(error => {
      if (error.code === 'ENOENT') throw new Error(`wiki-tools: source ${sourcePath} not found under the vault`)
      throw error
    })
    const hash = createHash('sha256').update(raw).digest('hex')
    const manifestPath = join(this.root, '.raw', '.manifest.json')
    const manifest = await readJson(manifestPath, { sources: {} })
    const previous = manifest.sources[rel] ?? manifest.sources[sourcePath]
    const alreadyIngested = previous !== undefined && previous.hash === hash
    manifest.sources[rel] = {
      hash,
      ingested_at: today(),
      pages_created: pagesCreated,
      pages_updated: pagesUpdated,
    }
    await mkdir(join(manifestPath, '..'), { recursive: true })
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    return { hash, alreadyIngested }
  }
}

/**
 * First non-heading, non-empty content line, for index summaries.
 * @param {string} content - markdown body.
 * @returns {string} up to 120 characters of the first prose line.
 */
function firstContentLine(content) {
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length > 0 && !trimmed.startsWith('#') && !trimmed.startsWith('---')) {
      return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed
    }
  }
  return '(no summary)'
}

/**
 * Escape regex metacharacters so a title containing `(`, `)`, `+`, etc. matches literally.
 * @param {string} value - raw title.
 * @returns {string} regex-safe text.
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Pick the index separator for one entry: reuse the matched line's style, else
 * the section's dominant style (`: ` or ` — `), else the canonical colon.
 * @param {string[]} section - existing entry lines of the index section.
 * @param {string | undefined} matched - the line being refreshed, when present.
 * @returns {string} the separator text before the summary.
 */
function indexSeparator(section, matched) {
  if (matched !== undefined && matched.includes(' — ')) return ' —'
  const dashes = section.filter(line => line.includes(' — ')).length
  const colons = section.filter(line => /: /.test(line)).length
  return dashes > colons ? ' —' : ':'
}

/**
 * Read a JSON file, returning the fallback when absent.
 * @param {string} path - absolute file path.
 * @param {T} fallback - value when the file is missing.
 * @returns {Promise<T>}
 * @template T
 */
async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}

/**
 * Recursively collect every Markdown page under a directory with title and wikilinks.
 * @param {string} directory - absolute directory to walk.
 * @returns {Promise<{ name: string, path: string, rel: string, fields: Record<string, unknown> | undefined, content: string, links: string[] }[]>}
 */
export async function collectMarkdown(directory) {
  const pages = []
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return pages
    throw error
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      pages.push(...await collectMarkdown(path))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const { fields, content } = splitFrontmatter(await readFile(path, 'utf8'), path)
      pages.push({
        name: entry.name.slice(0, -3),
        path,
        rel: relative(directory, path).split(sep).join('/'),
        fields,
        content,
        links: extractWikilinks(content),
        aliases: frontmatterAliases(fields),
      })
    }
  }
  pages.sort((left, right) => left.name.localeCompare(right.name))
  return pages
}

/**
 * Read a page's declared `aliases` frontmatter field (Obsidian resolves these
 * as link targets): a string or list of strings.
 * @param {Record<string, unknown> | undefined} fields - parsed frontmatter.
 * @returns {string[]} declared aliases, empty when absent or malformed.
 */
function frontmatterAliases(fields) {
  const raw = fields?.aliases
  if (typeof raw === 'string') return raw.trim().length > 0 ? [raw.trim()] : []
  if (Array.isArray(raw)) return raw.filter(alias => typeof alias === 'string' && alias.trim().length > 0).map(alias => alias.trim())
  return []
}

/**
 * Build the alias resolution map every link consumer shares: alias → page
 * title. Earlier pages win a duplicate alias, deterministically, because
 * {@link collectMarkdown} sorts by name.
 * @param {{ name: string, aliases?: string[] }[]} pages - collected pages.
 * @returns {Map<string, string>} alias → owning page title.
 */
export function buildAliasMap(pages) {
  const map = new Map()
  for (const page of pages) {
    for (const alias of page.aliases ?? []) {
      if (!map.has(alias)) map.set(alias, page.name)
    }
  }
  return map
}

/**
 * Resolve one wikilink target to a page title: direct name hit first, then the
 * alias map (Obsidian's resolution order).
 * @param {string} target - the raw link target.
 * @param {Set<string>} names - every page title.
 * @param {Map<string, string>} aliases - alias → page title.
 * @returns {string | undefined} the resolved page title, or undefined when dead.
 */
export function resolveLinkTarget(target, names, aliases) {
  if (names.has(target)) return target
  return aliases.get(target)
}

/**
 * Extract wikilink targets from markdown, dropping aliases and heading anchors.
 * Fenced code blocks and inline code spans are not links: examples written as
 * `` `[[Target]]` `` must not join the graph.
 * @param {string} content - markdown body.
 * @returns {string[]} link targets in order of appearance.
 */
export function extractWikilinks(content) {
  const links = []
  const withoutCode = content
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '')
  for (const match of withoutCode.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const target = match[1].split('|')[0].split('#')[0].trim()
    if (target.length > 0) links.push(target)
  }
  return links
}

/**
 * Whether a page basename is vault machinery rather than content: the index,
 * log, hot cache, overview, per-folder sub-indexes, and dated lint reports.
 * Lint reports quote past issues verbatim, so their wikilinks are records, not
 * graph edges.
 * @param {string} name - page basename without extension.
 * @returns {boolean} whether the page is machinery.
 */
export function isMachineryPage(name) {
  return META_FILENAMES.has(name.toLowerCase())
    || name.startsWith('_')
    || /^lint-report-/.test(name)
}
