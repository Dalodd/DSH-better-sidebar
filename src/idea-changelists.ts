/**
 * IDEA change lists for the Git sidebar.
 *
 * An IntelliJ-family project keeps its change lists in the
 * `ChangeListManager` component of `.idea/workspace.xml`:
 *
 * ```xml
 * <component name="ChangeListManager">
 *   <list default="true" id="…" name="Default Changelist" comment="">
 *     <change beforePath="$PROJECT_DIR$/src/a.ts" afterPath="$PROJECT_DIR$/src/a.ts" />
 *     <change afterPath="$PROJECT_DIR$/src/new.ts" afterDir="false" />
 *   </list>
 *   <list id="…" name="feature-x" comment="" />
 * </component>
 * ```
 *
 * The IDE records a change as the file's path, not as a git state: one list
 * can hold staged and unstaged files at once, and a NEW file carries only
 * `afterPath` while a DELETED one carries only `beforePath`. This reader
 * therefore returns the paths per list (absolute, '/'-normalized) and leaves
 * every git decision to the client: the lens maps each `git status` row onto
 * the first non-default list that contains it, and every row belonging to no
 * such list lands in the default list (the "new changes" bucket).
 *
 * The same scanner backs the drag-and-drop move: one `<change>` element is
 * moved from its source `<list>` to the target one with exact text surgery
 * (the row itself is reused verbatim, so its before/after spelling and flags
 * survive), then the document is re-parsed before it is written. A file the
 * source list does not name explicitly (the common default-list row) gets a
 * synthesized `<change>` in the target list; moving a file INTO the default
 * list only removes the named-list row, because the IDE assigns every
 * unlisted change to its default list.
 *
 * Parsing is hand-rolled on purpose: the host has no XML dependency (the
 * client's `@codemirror/lang-xml` is editor-side only), and this fragment is
 * tiny, machine-written by the IDE, and shallow. Every read failure degrades
 * to an empty list set instead of an error — the Git panel then renders its
 * plain staged/unstaged groups, exactly as it does outside an IDEA project.
 * A WRITE failure is reported to the caller (it is an explicit user action),
 * and the document is restored whenever a write cannot be verified.
 */
import { chmod, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, normalize, resolve } from 'node:path'
import { SidebarError } from './wire.ts'

/** One named change list read from `workspace.xml`. */
export interface IdeaChangeList {
  /** The IDE's list id (stable across renames); `changelist-<n>` when absent. */
  id: string
  /** The list's display name (the IDE's own, e.g. `Default Changelist`). */
  name: string
  /** The list's own comment line; '' when the IDE has none. */
  comment: string
  /** Whether new/unsorted changes belong here (exactly one list is the default). */
  isDefault: boolean
  /** Absolute '/'-normalized file paths the IDE associates with this list. */
  files: string[]
  /** Absolute '/'-normalized directory paths; files under them belong here too. */
  dirs: string[]
}

/** The `git.changelists` answer. */
export interface IdeaChangeListsResult {
  /** Whether the workspace root carries a `.idea` directory at all. */
  isIdeaProject: boolean
  /** The default list first, then the others in `workspace.xml` order. */
  lists: IdeaChangeList[]
  /** The workspace.xml mtime this answer was read from; a move sends it back
   *  as its conflict baseline. Absent when the file could not be read. */
  mtimeMs?: number
}

/** The kind of change a dragged row carries (attributes of the synthesized row). */
export type IdeaChangeStatus = 'new' | 'deleted' | 'modified'

/** One file of a drag-and-drop move. */
export interface IdeaChangeMoveFile {
  /** Absolute path of the file (the client projects the status row's path). */
  path: string
  /** The row's git status, used only when the source list has no explicit
   *  `<change>` to reuse. Defaults to `modified`. */
  status?: IdeaChangeStatus
}

/** One drag-and-drop move request (one file, or every file under a directory). */
export interface IdeaChangeMoveRequest {
  /** The list the row was dragged FROM (the IDE's id). */
  from: string
  /** The list it was dropped ONTO (the IDE's id). */
  to: string
  /** The files to move; a directory drag sends its whole visible subtree. */
  files: readonly IdeaChangeMoveFile[]
  /** The mtime of the `git.changelists` answer the drag came FROM. When the
   *  file changed since (the IDE saved it, another window moved something),
   *  the move refuses instead of overwriting the newer state. */
  expectedMtimeMs?: number
}

/** Upper bound on one move request (the status read itself is capped at 2000). */
const MAX_MOVE_FILES = 2_000

/**
 * Upper bound on the workspace.xml read. IntelliJ's file is normally a few
 * hundred kilobytes; a pathologically large one (a decade-old project with a
 * huge run-configuration/task history) would make the per-refresh read a
 * memory event, so past this the lens simply keeps its plain groups.
 */
const MAX_WORKSPACE_XML_BYTES = 32 * 1024 * 1024

/** One `<change>` element's location in the document plus its effective path. */
interface ChangeScan {
  /** Index of `<change` in the document text. */
  start: number
  /** Index just past the element's `/>` (or `</change>`). */
  end: number
  /** The element's exact text (reused verbatim when it moves lists). */
  raw: string
  /** Absolute '/'-normalized file path; undefined for a directory row. */
  file?: string
  /** Absolute '/'-normalized directory path; undefined for a file row. */
  dir?: string
}

/** One `<list>` element's location and parsed children. */
interface ListScan {
  id: string
  name: string
  comment: string
  isDefault: boolean
  /** Index of `<list` in the document text. */
  start: number
  /** Index just past the start tag's `>`. */
  openEnd: number
  /** Index of `</list>` (equals `openEnd` for a self-closing list). */
  closeStart: number
  /** Index just past `</list>` (just past `/>` for a self-closing list). */
  end: number
  selfClosing: boolean
  changes: ChangeScan[]
}

/**
 * Read and parse one workspace's IDEA change lists.
 *
 * @param workspaceRoot - the session workspace root (where `.idea` would sit).
 * @returns `{ isIdeaProject: false, lists: [] }` when there is no `.idea`
 *   directory; a project whose workspace.xml is missing, unreadable, too
 *   large or malformed answers `isIdeaProject: true` with no lists, which the
 *   client treats exactly like "no named change lists".
 */
export async function readIdeaChangeLists(workspaceRoot: string): Promise<IdeaChangeListsResult> {
  const resolved = await readWorkspaceDocument(workspaceRoot)
  if (resolved === undefined) return { isIdeaProject: false, lists: [] }
  if (resolved.xml === undefined) return { isIdeaProject: true, lists: [] }
  try {
    return {
      isIdeaProject: true,
      lists: parseChangeListManager(resolved.xml, workspaceRoot),
      mtimeMs: resolved.mtimeMs,
    }
  } catch {
    // A malformed fragment must cost the grouping feature, never the panel.
    return { isIdeaProject: true, lists: [] }
  }
}

/**
 * Move one or more files' `<change>` rows between two change lists and persist
 * them in ONE edit.
 *
 * A file row sends one file; a directory drag sends every changed file under
 * the directory (the client collects them). The source row is reused verbatim
 * when the source list names the file; otherwise one is synthesized for the
 * target list (moving into the default list needs no row at all — an unlisted
 * change belongs there). The result is re-parsed and verified BEFORE it is
 * written; a document whose verification fails is never written, and a failed
 * atomic write falls back to an in-place write / stays unmodified.
 *
 * @param workspaceRoot - the workspace whose `.idea/workspace.xml` is edited.
 * @param request - the move (see {@link IdeaChangeMoveRequest}).
 * @returns the fresh lists (default first) and the new mtime.
 * @throws {SidebarError} `changelist-stale` when the file moved on since the
 *   caller read it, `not-found` for an unknown list, `changelist-move-failed`
 *   when the write could not be completed.
 */
export async function moveIdeaChangeListFiles(
  workspaceRoot: string,
  request: IdeaChangeMoveRequest,
): Promise<IdeaChangeListsResult> {
  if (request.files.length === 0) throw new SidebarError('bad-request', 'no files to move')
  if (request.files.length > MAX_MOVE_FILES) {
    throw new SidebarError('bad-request', `too many files to move (max ${MAX_MOVE_FILES})`)
  }
  return queueWorkspaceWrite(workspaceRoot, () => performMove(workspaceRoot, request))
}

/** Read the workspace.xml, distinguishing "not an IDEA project" from "no file". */
async function readWorkspaceDocument(workspaceRoot: string): Promise<{ xml?: string; mtimeMs?: number } | undefined> {
  const ideaDirectory = join(workspaceRoot, '.idea')
  try {
    if (!(await stat(ideaDirectory)).isDirectory()) return undefined
  } catch {
    return undefined
  }
  const workspaceFile = join(ideaDirectory, 'workspace.xml')
  try {
    const info = await stat(workspaceFile)
    if (!info.isFile() || info.size > MAX_WORKSPACE_XML_BYTES) return {}
    return { xml: await readFile(workspaceFile, 'utf8'), mtimeMs: info.mtimeMs }
  } catch {
    return {}
  }
}

/** One uncached move (see {@link queueWorkspaceWrite}). */
async function performMove(workspaceRoot: string, request: IdeaChangeMoveRequest): Promise<IdeaChangeListsResult> {
  if (request.from === request.to) return readIdeaChangeLists(workspaceRoot)
  const workspaceFile = join(workspaceRoot, '.idea', 'workspace.xml')
  const before = await stat(workspaceFile).catch(() => undefined)
  if (before === undefined || !before.isFile()) {
    throw new SidebarError('not-found', 'workspace.xml not found', 404)
  }
  if (before.size > MAX_WORKSPACE_XML_BYTES) {
    throw new SidebarError('too-large', 'workspace.xml is too large to edit', 413)
  }
  if (request.expectedMtimeMs !== undefined && before.mtimeMs !== request.expectedMtimeMs) {
    throw new SidebarError('changelist-stale', 'the change lists changed since they were loaded; refresh and retry', 409)
  }
  const original = await readFile(workspaceFile, 'utf8')
  const lists = scanChangeListManager(original, workspaceRoot)
  const source = lists.find(list => list.id === request.from)
  const target = lists.find(list => list.id === request.to)
  if (source === undefined || target === undefined) {
    throw new SidebarError('not-found', `unknown change list "${source === undefined ? request.from : request.to}"`, 404)
  }
  const requested = new Map<string, { path: string; status?: IdeaChangeStatus }>()
  for (const file of request.files) {
    const path = normalizeListedPath(file.path)
    const key = pathKey(path)
    if (!requested.has(key)) requested.set(key, { path, ...(file.status === undefined ? {} : { status: file.status }) })
    if (requested.size > MAX_MOVE_FILES) {
      throw new SidebarError('bad-request', `too many files to move (max ${MAX_MOVE_FILES})`)
    }
  }
  const removals: Edit[] = []
  const rows: string[] = []
  const keys: string[] = []
  for (const [key, file] of requested) {
    const existing = source.changes.find(change => change.file !== undefined && pathKey(change.file) === key)
    // A file a list owns only through a recorded DIRECTORY change has no row
    // of its own: moving just this file would leave the directory entry still
    // claiming it, so the move is refused instead of silently doing half.
    if (existing === undefined && source.changes.some(change => change.dir !== undefined && isUnderDirectory(change.dir, key))) {
      throw new SidebarError('bad-request', 'this file belongs to a directory change and cannot be moved alone', 409)
    }
    // Moving into the default list needs no explicit row: an unlisted change
    // is IN the default list by definition.
    const targetHasRow = target.changes.some(change => change.file !== undefined && pathKey(change.file) === key)
    if (existing !== undefined) removals.push(removalEdit(original, existing))
    if (!target.isDefault && !targetHasRow) {
      rows.push(existing?.raw ?? synthesizeChangeRow(original, workspaceRoot, file.path, file.status ?? 'modified'))
    }
    keys.push(key)
  }
  if (removals.length === 0 && rows.length === 0) {
    // Nothing to remove and nothing to add (e.g. a stale drag from default):
    // report the current state without writing.
    return { isIdeaProject: true, lists: publicLists(lists), mtimeMs: before.mtimeMs }
  }
  const edits: Edit[] = [...removals]
  if (rows.length > 0) edits.push(insertionEdit(original, target, rows))
  const updated = applyEdits(original, edits)
  // Verify BEFORE writing: a document that does not show the requested move
  // is a bug in the surgery, never something to persist.
  verifyMove(updated, workspaceRoot, { from: request.from, to: request.to, keys, targetIsDefault: target.isDefault })
  const text = updated
  const info = await stat(workspaceFile).catch(() => undefined)
  if (info === undefined || info.mtimeMs !== before.mtimeMs) {
    throw new SidebarError('changelist-stale', 'the change lists changed while the move was being prepared; retry', 409)
  }
  const temporary = `${workspaceFile}.dsh-${process.pid}-${Date.now()}.tmp`
  try {
    await writeFile(temporary, text, 'utf8')
    await chmod(temporary, before.mode & 0o777).catch(() => undefined)
    await rename(temporary, workspaceFile)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    // A running IDE can hold workspace.xml without delete sharing, which makes
    // the atomic rename fail on Windows while an in-place write still works.
    // Prefer the rename; fall back rather than refusing a movable file.
    try {
      await writeFile(workspaceFile, text, 'utf8')
    } catch {
      throw new SidebarError('changelist-move-failed', messageOf(error), 500)
    }
  }
  const after = await stat(workspaceFile).catch(() => undefined)
  return {
    isIdeaProject: true,
    lists: publicLists(scanChangeListManager(text, workspaceRoot)),
    ...(after !== undefined ? { mtimeMs: after.mtimeMs } : {}),
  }
}

/** One text replacement in the document. */
interface Edit {
  start: number
  end: number
  insert: string
}

/**
 * The edit that removes one `<change>` line. The element's own indentation and
 * trailing newline go with it, so no blank line is left behind; an element
 * sharing a line with another row loses only its own text.
 */
function removalEdit(text: string, change: ChangeScan): Edit {
  let start = change.start
  let end = change.end
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  if (lineStart > 0 && text.slice(lineStart, start).trim() === '') {
    start = lineStart
    if (text.startsWith('\r\n', end)) end += 2
    else if (text[end] === '\n') end += 1
  }
  return { start, end, insert: '' }
}

/**
 * The edit that appends rows to a target list. A self-closing `<list />` is
 * opened first; otherwise the rows are inserted on their own lines before the
 * closing tag, using the indentation of the list's existing rows.
 */
function insertionEdit(text: string, list: ListScan, rows: readonly string[]): Edit {
  const listIndent = indentationOf(text, list.start)
  const first = list.changes[0]
  const indent = first === undefined ? `${listIndent}  ` : indentationOf(text, first.start)
  const block = rows.map(row => `${indent}${row}`).join('\n')
  if (list.selfClosing) {
    const slash = text.lastIndexOf('/>', list.end)
    // Drop the conventional space before `/>` so the opened tag reads like an
    // ordinary `<list …>` instead of `<list … >`.
    const start = slash > 0 && text[slash - 1] === ' ' ? slash - 1 : slash
    return {
      start,
      end: list.end,
      insert: `>\n${block}\n${listIndent}</list>`,
    }
  }
  const closeLineStart = text.lastIndexOf('\n', list.closeStart - 1) + 1
  const beforeClose = text.slice(closeLineStart, list.closeStart)
  if (closeLineStart > 0 && beforeClose.trim() === '') {
    return { start: closeLineStart, end: closeLineStart, insert: `${block}\n` }
  }
  return { start: list.closeStart, end: list.closeStart, insert: `\n${block}` }
}

/** Apply non-overlapping edits on their original offsets (descending). */
function applyEdits(text: string, edits: readonly Edit[]): string {
  let result = text
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    result = result.slice(0, edit.start) + edit.insert + result.slice(edit.end)
  }
  return result
}

/**
 * Prove that a candidate document moved the files: the source list no longer
 * names any of them, and a non-default target names every one. A default
 * target needs no rows (an unlisted change belongs there).
 */
function verifyMove(
  text: string,
  workspaceRoot: string,
  check: { from: string; to: string; keys: readonly string[]; targetIsDefault: boolean },
): void {
  const lists = scanChangeListManager(text, workspaceRoot)
  const source = lists.find(list => list.id === check.from)
  const target = lists.find(list => list.id === check.to)
  const names = (list: ListScan | undefined, key: string): boolean => list !== undefined
    && list.changes.some(change => change.file !== undefined && pathKey(change.file) === key)
  if (source === undefined || target === undefined || check.keys.some(key => names(source, key))) {
    throw new SidebarError('changelist-move-failed', 'the workspace.xml move could not be verified', 500)
  }
  if (!check.targetIsDefault && check.keys.some(key => !names(target, key))) {
    throw new SidebarError('changelist-move-failed', 'the workspace.xml move could not be verified', 500)
  }
}

/** The public view of one scanned list, default first. */
function publicLists(lists: readonly ListScan[]): IdeaChangeList[] {
  return [...lists.filter(list => list.isDefault), ...lists.filter(list => !list.isDefault)].map(list => ({
    id: list.id,
    name: list.name,
    comment: list.comment,
    isDefault: list.isDefault,
    files: uniquePaths(list.changes.flatMap(change => (change.file === undefined ? [] : [change.file]))),
    dirs: uniquePaths(list.changes.flatMap(change => (change.dir === undefined ? [] : [change.dir]))),
  }))
}

/**
 * Extract the change lists from one `workspace.xml` document.
 *
 * Exported for the parser's own specs; {@link readIdeaChangeLists} is the
 * surface the route uses.
 *
 * @param xml - the whole workspace.xml text (BOM tolerated).
 * @param projectRoot - value substituted for the IDE's `$PROJECT_DIR$` marker.
 * @returns the lists, default first; one list is always marked default when
 *   any list exists.
 */
export function parseChangeListManager(xml: string, projectRoot: string): IdeaChangeList[] {
  return publicLists(scanChangeListManager(xml, projectRoot))
}

/**
 * Scan the `ChangeListManager` component with document offsets. The scanner is
 * the single source of truth for both the reader and the move: parse and write
 * can never disagree about which element a list/row occupies.
 *
 * @param xml - the document text.
 * @param projectRoot - `$PROJECT_DIR$` expansion.
 * @returns the lists in document order, with ids made unique and exactly one
 *   default marked.
 */
function scanChangeListManager(xml: string, projectRoot: string): ListScan[] {
  const body = componentBodyOf(xml, 'ChangeListManager')
  if (body === undefined) return []
  const lists: ListScan[] = []
  const usedIds = new Set<string>()
  const listPattern = /<list\b([^>]*?)(\/?)>/gi
  let match: RegExpExecArray | null
  while ((match = listPattern.exec(body.text)) !== null) {
    const attributes = attributesOf(match[1] ?? '')
    const openEnd = match.index + match[0].length
    const selfClosing = match[2] === '/'
    let closeStart = openEnd
    let end = openEnd
    if (!selfClosing) {
      const close = body.text.indexOf('</list>', openEnd)
      closeStart = close === -1 ? body.text.length : close
      end = close === -1 ? body.text.length : close + '</list>'.length
      listPattern.lastIndex = end
    }
    const rawId = (attributes.get('id') ?? '').trim()
    const rawName = (attributes.get('name') ?? '').trim()
    // The list id is the client's React key / DOM identity and the move
    // request's target, so it has to be unique even in a hand-edited file.
    let id = rawId === '' ? `changelist-${lists.length + 1}` : rawId
    if (usedIds.has(id)) id = `${id}-${lists.length + 1}`
    usedIds.add(id)
    lists.push({
      id,
      name: rawName,
      comment: attributes.get('comment') ?? '',
      isDefault: (attributes.get('default') ?? '').toLowerCase() === 'true',
      start: body.start + match.index,
      openEnd: body.start + openEnd,
      closeStart: body.start + closeStart,
      end: body.start + end,
      selfClosing,
      changes: selfClosing ? [] : scanChanges(body.text.slice(openEnd, closeStart), body.start + openEnd, projectRoot),
    })
  }
  if (lists.length === 0) return []
  // The IDE always marks its default list; a hand-edited file that doesn't is
  // still expected to have somewhere for new changes to land.
  if (!lists.some(list => list.isDefault)) lists[0]!.isDefault = true
  return lists
}

/**
 * Scan one list's `<change>` rows with absolute offsets in the document.
 *
 * The path that names the file NOW is `afterPath`; a deleted file has none,
 * so `beforePath` is the only spelling that can match the `git status` row
 * (git reports a deletion at its old path). The `*Dir` flags tell which bucket
 * the path belongs to — a directory change covers every file below it.
 *
 * @param inner - the `<list>` element's inner XML.
 * @param baseOffset - document offset of `inner[0]`.
 * @param projectRoot - `$PROJECT_DIR$` expansion.
 */
function scanChanges(inner: string, baseOffset: number, projectRoot: string): ChangeScan[] {
  const changes: ChangeScan[] = []
  const changePattern = /<change\b([^>]*?)(\/?)>/gi
  let match: RegExpExecArray | null
  while ((match = changePattern.exec(inner)) !== null) {
    const selfClosing = match[2] === '/'
    let end = match.index + match[0].length
    if (!selfClosing) {
      // IDEA always self-closes `<change>`; a paired spelling still must not
      // let its (empty) body restart the scan.
      const close = inner.indexOf('</change>', end)
      end = close === -1 ? inner.length : close + '</change>'.length
      changePattern.lastIndex = end
    }
    const attributes = attributesOf(match[1] ?? '')
    const afterPath = resolveListedPath(attributes.get('afterPath'), projectRoot)
    const beforePath = resolveListedPath(attributes.get('beforePath'), projectRoot)
    const chosen = afterPath ?? beforePath
    if (chosen === undefined) continue
    const isDirectory = (attributes.get(afterPath === undefined ? 'beforeDir' : 'afterDir') ?? '').toLowerCase() === 'true'
    changes.push({
      start: baseOffset + match.index,
      end: baseOffset + end,
      raw: inner.slice(match.index, end),
      ...(isDirectory ? { dir: chosen } : { file: chosen }),
    })
  }
  return changes
}

/**
 * The ChangeListManager component's inner text plus its document offset.
 *
 * @param xml - the document text (a BOM simply sits before the match).
 * @param name - the component's exact `name` attribute value.
 * @returns the slice and its start offset, or undefined when absent; a
 *   self-closed component answers an empty slice.
 */
function componentBodyOf(xml: string, name: string): { text: string; start: number } | undefined {
  const openPattern = new RegExp(`<component\\b[^>]*\\bname\\s*=\\s*["']${name}["'][^>]*>`, 'i')
  const match = openPattern.exec(xml)
  if (match === null) return undefined
  const start = match.index + match[0].length
  if (/\/>\s*$/.test(match[0])) return { text: '', start }
  const close = xml.indexOf('</component>', start)
  return { text: xml.slice(start, close === -1 ? xml.length : close), start }
}

/**
 * Synthesize one `<change>` row for a file the source list did not name.
 * The path spelling follows the document's own convention (`$PROJECT_DIR$`
 * when any existing row uses it, otherwise the absolute path).
 *
 * @param document - the whole document (style probe).
 * @param projectRoot - `$PROJECT_DIR$` expansion.
 * @param path - absolute '/'-normalized file path.
 * @param status - new (afterPath only), deleted (beforePath only) or modified.
 */
function synthesizeChangeRow(document: string, projectRoot: string, path: string, status: IdeaChangeStatus): string {
  const stored = storedPathOf(document, projectRoot, path)
  const escaped = escapeXmlAttribute(stored)
  const parts: string[] = []
  if (status !== 'new') parts.push(`beforePath="${escaped}"`, 'beforeDir="false"')
  if (status !== 'deleted') parts.push(`afterPath="${escaped}"`, 'afterDir="false"')
  return `<change ${parts.join(' ')} />`
}

/**
 * The IDE-style spelling of one absolute path: `$PROJECT_DIR$`-relative when
 * the document already uses that marker and the file sits under the project,
 * the absolute '/'-normalized path otherwise.
 */
function storedPathOf(document: string, projectRoot: string, path: string): string {
  if (!document.includes('$PROJECT_DIR$')) return path
  const under = relativeUnder(projectRoot, path)
  return under === undefined ? path : `$PROJECT_DIR$/${under}`
}

/** `target` relative to `root` ('/'-joined), or undefined when outside it. */
function relativeUnder(root: string, target: string): string | undefined {
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const full = target.replace(/\\/g, '/').replace(/\/+$/, '')
  const fold = isWindowsSpelling(base) || isWindowsSpelling(full)
  const compareBase = fold ? base.toLowerCase() : base
  const compareFull = fold ? full.toLowerCase() : full
  if (!compareFull.startsWith(`${compareBase}/`)) return undefined
  return full.slice(base.length + 1)
}

/** Whether a path uses a Windows drive or UNC spelling (case-insensitive). */
function isWindowsSpelling(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path)
}

/** Normalize a caller-supplied absolute path the way the scanner stores one. */
function normalizeListedPath(path: string): string {
  return normalize(path).replaceAll('\\', '/')
}

/** Whether one file key lies under a directory key. */
function isUnderDirectory(directory: string, fileKey: string): boolean {
  const directoryKey = pathKey(directory)
  return fileKey.startsWith(`${directoryKey}/`)
}

/** The comparison key of one path (case folds only for Windows spellings). */
function pathKey(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return isWindowsSpelling(normalized) ? normalized.toLowerCase() : normalized
}

/** The whitespace before the line containing `offset` ('' on its own column). */
function indentationOf(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1
  return text.slice(lineStart, offset)
}

/** Escape one XML attribute value (double-quoted attributes). */
function escapeXmlAttribute(value: string): string {
  return value.replace(/[&<>"]/g, character => {
    switch (character) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      default: return '&quot;'
    }
  })
}

/**
 * Parse one XML start tag's attribute list. Both quote styles are accepted
 * (the IDE writes double quotes; a hand-edited file may not), and values are
 * entity-decoded.
 *
 * @param source - the text between the tag name and `>`.
 * @returns the attributes keyed by name (the last spelling wins).
 */
function attributesOf(source: string): Map<string, string> {
  const attributes = new Map<string, string>()
  for (const match of source.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attributes.set(match[1]!, decodeXml(match[2] ?? match[3] ?? ''))
  }
  return attributes
}

/**
 * Decode the XML entities an IDE-written attribute can carry: the five named
 * ones plus decimal/hex character references.
 *
 * @param value - the raw attribute text.
 * @returns the decoded text.
 */
function decodeXml(value: string): string {
  if (!value.includes('&')) return value
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (whole, entity: string) => {
    switch (entity.toLowerCase()) {
      case 'amp': return '&'
      case 'lt': return '<'
      case 'gt': return '>'
      case 'quot': return '"'
      case 'apos': return "'"
      default: break
    }
    const codePoint = entity.toLowerCase().startsWith('#x')
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10)
    if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return whole
    try {
      return String.fromCodePoint(codePoint)
    } catch {
      return whole
    }
  })
}

/**
 * Turn one stored path into an absolute '/'-normalized path.
 *
 * The IDE writes `$PROJECT_DIR$/…` (and, in older projects, `file://` URLs);
 * a path naming an unresolved variable must be dropped rather than treated as
 * a literal `$MODULE_DIR$/…` name that can never match a git row.
 *
 * @param raw - the attribute's decoded value.
 * @param projectRoot - `$PROJECT_DIR$` expansion.
 * @returns the absolute path, or undefined when the spelling is unusable.
 */
function resolveListedPath(raw: string | undefined, projectRoot: string): string | undefined {
  if (raw === undefined) return undefined
  let value = raw.trim()
  if (value === '') return undefined
  if (/^file:\/\//i.test(value)) {
    value = value.replace(/^file:\/\//i, '')
    // Java spells a drive URL as `file:///C:/…`: the slash before the drive
    // letter belongs to the URL, not to the path.
    if (/^\/[A-Za-z]:[\\/]/.test(value)) value = value.slice(1)
  }
  value = value.replaceAll('$PROJECT_DIR$', projectRoot)
  if (value.includes('$')) return undefined
  const absolute = isAbsolute(value) ? value : resolve(projectRoot, value)
  return normalize(absolute).replaceAll('\\', '/')
}

/** De-duplicate one bucket while keeping the IDE's order. */
function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)]
}

/** One error's display text. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Serialize the moves of one workspace. The document is re-read per move, so
 * two drags can never interleave their surgery; the queue is keyed by the
 * workspace root and drops its entry when the chain settles.
 */
const writeQueues = new Map<string, Promise<unknown>>()
function queueWorkspaceWrite<T>(workspaceRoot: string, action: () => Promise<T>): Promise<T> {
  const key = pathKey(workspaceRoot)
  const previous = writeQueues.get(key) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(action)
  const settled = run.then(() => undefined, () => undefined).then(() => {
    if (writeQueues.get(key) === settled) writeQueues.delete(key)
  })
  writeQueues.set(key, settled)
  return run
}
