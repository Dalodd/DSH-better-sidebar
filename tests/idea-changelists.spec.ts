/**
 * IDEA change lists for the Git lens.
 *
 * The reader has two layers worth pinning separately:
 * - `readIdeaChangeLists` (filesystem): `.idea` detection, missing/unreadable
 *   `workspace.xml`, and the read-size guard. A non-IDEA workspace must answer
 *   `false` so the client keeps its plain staged/unstaged groups.
 * - `parseChangeListManager` (XML): the exact dialect IntelliJ writes —
 *   `$PROJECT_DIR$`, `file://` URLs, `afterPath`-only NEW rows, `beforePath`-only
 *   DELETED rows, `*Dir` directory rows, XML entities, the default list first,
 *   and an unmarked default falling back to the first list.
 *
 * The route test mounts the real `/sidebar/api` surface and proves the
 * workspace root (not a selected checkout) drives the read.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import type { SidebarWebRoute, SidebarWebUpgradeRoute } from '../src/context-types.ts'
import { moveIdeaChangeListFiles, parseChangeListManager, readIdeaChangeLists } from '../src/idea-changelists.ts'
import { removeTree } from './temp-tree.ts'

/** One scratch project directory (removed by the caller's finally). */
function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-sidebar-idea-'))
}

/** Write `<root>/.idea/workspace.xml` (creating the directory). */
function writeWorkspaceXml(root: string, xml: string): void {
  mkdirSync(join(root, '.idea'), { recursive: true })
  writeFileSync(join(root, '.idea', 'workspace.xml'), xml, 'utf8')
}

/** One absolute path in the reader's '/'-normalized spelling. */
function slash(path: string): string {
  return path.replaceAll('\\', '/')
}

describe('readIdeaChangeLists (filesystem probe)', () => {
  it('answers false without a .idea directory', async () => {
    const root = makeWorkspace()
    try {
      expect(await readIdeaChangeLists(root)).toEqual({ isIdeaProject: false, lists: [] })
    } finally {
      removeTree(root)
    }
  })

  it('answers true with no lists when workspace.xml is missing', async () => {
    const root = makeWorkspace()
    try {
      mkdirSync(join(root, '.idea'))
      expect(await readIdeaChangeLists(root)).toEqual({ isIdeaProject: true, lists: [] })
    } finally {
      removeTree(root)
    }
  })

  it('reads the ChangeListManager of a real workspace file', async () => {
    const root = makeWorkspace()
    try {
      writeWorkspaceXml(root, [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<project version="4">',
        '  <component name="ChangeListManager">',
        '    <list id="feature" name="feature-x" comment="shipping">',
        '      <change beforePath="$PROJECT_DIR$/src/old name.ts" afterPath="$PROJECT_DIR$/src/new name.ts" />',
        '      <change afterPath="$PROJECT_DIR$/src/fresh.ts" afterDir="false" />',
        '      <change beforePath="$PROJECT_DIR$/src/gone.ts" />',
        '    </list>',
        '    <list default="true" id="default" name="Default Changelist" comment="">',
        '      <change afterPath="$PROJECT_DIR$/README.md" />',
        '    </list>',
        '    <option name="SHOW_DIALOG" value="false" />',
        '  </component>',
        '</project>',
      ].join('\n'))
      const result = await readIdeaChangeLists(root)
      expect(result.isIdeaProject).toBe(true)
      expect(result.lists.map(list => list.id)).toEqual(['default', 'feature'])
      expect(result.lists[0]).toMatchObject({ name: 'Default Changelist', isDefault: true })
      expect(result.lists[1]).toMatchObject({ name: 'feature-x', comment: 'shipping', isDefault: false })
      expect(result.lists[1]!.files).toEqual([
        slash(resolve(root, 'src/new name.ts')),
        slash(resolve(root, 'src/fresh.ts')),
        slash(resolve(root, 'src/gone.ts')),
      ])
      expect(result.lists[1]!.dirs).toEqual([])
    } finally {
      removeTree(root)
    }
  })

  it('degrades a malformed workspace file to an empty list set, never a throw', async () => {
    const root = makeWorkspace()
    try {
      writeWorkspaceXml(root, '<project><component name="ChangeListManager"><list name="x">')
      await expect(readIdeaChangeLists(root)).resolves.toMatchObject({ isIdeaProject: true })
    } finally {
      removeTree(root)
    }
  })
})

describe('parseChangeListManager (IntelliJ XML dialect)', () => {
  // A root absolute on the RUNNING platform: the parser resolves relative rows
  // against it, and `/project` is not absolute on Windows (nor `C:/project` on
  // POSIX).
  const ROOT = process.platform === 'win32' ? 'C:/project' : '/project'
  /** One expected path under {@link ROOT}. */
  const at = (path: string): string => `${ROOT}/${path}`

  it('puts the default list first regardless of document order', () => {
    const lists = parseChangeListManager(`
      <component name="ChangeListManager">
        <list id="a" name="first"><change afterPath="$PROJECT_DIR$/a.ts" /></list>
        <list default="true" id="d" name="Default Changelist" />
        <list id="b" name="second"><change afterPath="$PROJECT_DIR$/b.ts" /></list>
      </component>`, ROOT)
    expect(lists.map(list => list.id)).toEqual(['d', 'a', 'b'])
    expect(lists.map(list => list.isDefault)).toEqual([true, false, false])
  })

  it('reads afterPath for NEW/MODIFIED rows and beforePath for a deletion', () => {
    const lists = parseChangeListManager(`
      <component name="ChangeListManager">
        <list default="true" id="d" name="D">
          <change type="NEW" beforePath="" afterPath="$PROJECT_DIR$/src/new.ts" afterDir="false" />
          <change type="DELETED" beforePath="$PROJECT_DIR$/src/gone.ts" />
        </list>
      </component>`, ROOT)
    expect(lists[0]!.files).toEqual([at('src/new.ts'), at('src/gone.ts')])
    expect(lists[0]!.dirs).toEqual([])
  })

  it('routes *Dir rows to the directory bucket and expands file:// URLs', () => {
    const lists = parseChangeListManager(`
      <component name="ChangeListManager">
        <list default="true" id="d" name="D">
          <change afterPath="$PROJECT_DIR$/generated" afterDir="true" />
          <change beforePath="$PROJECT_DIR$/legacy-dir" beforeDir="true" />
          <change afterPath="file://$PROJECT_DIR$/src/url.ts" />
        </list>
      </component>`, ROOT)
    expect(lists[0]!.dirs).toEqual([at('generated'), at('legacy-dir')])
    expect(lists[0]!.files).toEqual([at('src/url.ts')])
  })

  it('decodes XML entities and drops unresolved IDE variables', () => {
    const lists = parseChangeListManager(`
      <component name="ChangeListManager">
        <list default="true" id="d" name="D">
          <change afterPath="$PROJECT_DIR$/src/a &amp; b.ts" />
          <change afterPath="$MODULE_DIR$/src/unresolved.ts" />
          <change afterPath="relative/file.ts" />
        </list>
      </component>`, ROOT)
    expect(lists[0]!.files).toEqual([at('src/a & b.ts'), at('relative/file.ts')])
  })

  it('marks the first list default when the file marks none', () => {
    const lists = parseChangeListManager(`
      <component name="ChangeListManager">
        <list id="a" name="A" />
        <list id="b" name="B" />
      </component>`, ROOT)
    expect(lists.map(list => list.isDefault)).toEqual([true, false])
  })

  it('returns no lists when the component is absent or self-closed', () => {
    expect(parseChangeListManager('<project />', ROOT)).toEqual([])
    expect(parseChangeListManager('<project><component name="ChangeListManager" /></project>', ROOT)).toEqual([])
  })

  it('distinguishes a ChangeListManager from other components', () => {
    const lists = parseChangeListManager(`
      <project>
        <component name="Other">
          <list default="true" id="x" name="not a changelist" />
        </component>
        <component name="ChangeListManager">
          <list default="true" id="d" name="D" />
        </component>
      </project>`, ROOT)
    expect(lists.map(list => list.id)).toEqual(['d'])
  })
})

describe('moveIdeaChangeListFiles (drag between ChangeLists)', () => {
  /** Two files in named/default lists plus a self-closing empty list. */
  const MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="ChangeListManager">
    <list default="true" id="default" name="Local" comment="">
      <change beforePath="$PROJECT_DIR$/src/other.ts" afterPath="$PROJECT_DIR$/src/other.ts" afterDir="false" />
    </list>
    <list id="feature" name="feature-x" comment="">
      <change afterPath="$PROJECT_DIR$/src/feature.ts" afterDir="false" />
    </list>
    <list id="empty" name="empty-x" comment="" />
  </component>
</project>`

  /** The current workspace.xml text. */
  const readXml = (root: string): string => readFileSync(join(root, '.idea', 'workspace.xml'), 'utf8')

  /** How many times `needle` occurs in `haystack`. */
  const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1

  it('moves an existing row verbatim from the default list into a named list', async () => {
    const root = makeWorkspace()
    try {
      writeWorkspaceXml(root, MANIFEST)
      const before = await readIdeaChangeLists(root)
      const result = await moveIdeaChangeListFiles(root, {
        from: 'default',
        to: 'feature',
        files: [{ path: resolve(root, 'src/other.ts') }],
        expectedMtimeMs: before.mtimeMs!,
      })
      const target = result.lists.find(list => list.id === 'feature')!
      expect(target.files).toContain(slash(resolve(root, 'src/other.ts')))
      expect(result.lists.find(list => list.id === 'default')!.files).toEqual([])
      // The row itself moved (its before/after spelling is preserved) and the
      // empty source list no longer names it.
      const xml = readXml(root)
      expect(occurrences(xml, 'src/other.ts')).toBe(2) // beforePath + afterPath of ONE row
      expect(xml.slice(xml.indexOf('id="default"'), xml.indexOf('</list>'))).not.toContain('src/other.ts')
      expect(xml.indexOf('src/other.ts')).toBeGreaterThan(xml.indexOf('id="feature"'))
      expect(xml).toContain('beforePath="$PROJECT_DIR$/src/other.ts"')
      expect(result.mtimeMs).toBeGreaterThanOrEqual(before.mtimeMs!)
    } finally {
      removeTree(root)
    }
  })

  it('moves every file of a directory in ONE edit', async () => {
    const root = makeWorkspace()
    try {
      writeWorkspaceXml(root, `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="ChangeListManager">
    <list default="true" id="default" name="Local" comment="">
      <change afterPath="$PROJECT_DIR$/dir/a.ts" />
      <change afterPath="$PROJECT_DIR$/dir/b.ts" />
      <change afterPath="$PROJECT_DIR$/keep.ts" />
    </list>
    <list id="feature" name="feature-x" comment="" />
  </component>
</project>`)
      const before = await readIdeaChangeLists(root)
      const result = await moveIdeaChangeListFiles(root, {
        from: 'default',
        to: 'feature',
        // The duplicate stands for a file that appears in two bands: it must
        // be moved (and written) exactly once.
        files: [
          { path: resolve(root, 'dir/a.ts'), status: 'new' },
          { path: resolve(root, 'dir/a.ts'), status: 'new' },
          { path: resolve(root, 'dir/b.ts'), status: 'new' },
        ],
        expectedMtimeMs: before.mtimeMs!,
      })
      expect(result.lists.find(list => list.id === 'feature')!.files).toEqual([
        slash(resolve(root, 'dir/a.ts')),
        slash(resolve(root, 'dir/b.ts')),
      ])
      expect(result.lists.find(list => list.id === 'default')!.files)
        .toEqual([slash(resolve(root, 'keep.ts'))])
      const xml = readXml(root)
      expect(occurrences(xml, 'dir/a.ts')).toBe(1)
      expect(occurrences(xml, 'dir/b.ts')).toBe(1)
      expect(xml.indexOf('dir/a.ts')).toBeGreaterThan(xml.indexOf('id="feature"'))
      const defaultBlock = xml.slice(xml.indexOf('id="default"'), xml.indexOf('</list>'))
      expect(defaultBlock).toContain('keep.ts')
      expect(defaultBlock).not.toContain('dir/a.ts')
    } finally {
      removeTree(root)
    }
  })

  it('moves a named row back into the default list by removing it', async () => {
    const root = makeWorkspace()
    try {
      writeWorkspaceXml(root, MANIFEST)
      const before = await readIdeaChangeLists(root)
      const result = await moveIdeaChangeListFiles(root, {
        from: 'feature',
        to: 'default',
        files: [{ path: resolve(root, 'src/feature.ts') }],
        expectedMtimeMs: before.mtimeMs!,
      })
      expect(result.lists.find(list => list.id === 'feature')!.files).toEqual([])
      // The default list keeps only its own explicit row; the moved file is
      // implicit there (an unlisted change belongs to the default list).
      expect(result.lists.find(list => list.id === 'default')!.files)
        .toEqual([slash(resolve(root, 'src/other.ts'))])
      expect(readXml(root)).not.toContain('src/feature.ts')
    } finally {
      removeTree(root)
    }
  })

  it('opens a self-closing target list and synthesizes the row', async () => {
    const root = makeWorkspace()
    try {
      writeWorkspaceXml(root, MANIFEST)
      const before = await readIdeaChangeLists(root)
      const result = await moveIdeaChangeListFiles(root, {
        from: 'default',
        to: 'empty',
        files: [{ path: resolve(root, 'src/new file.ts'), status: 'new' }],
        expectedMtimeMs: before.mtimeMs!,
      })
      expect(result.lists.find(list => list.id === 'empty')!.files)
        .toEqual([slash(resolve(root, 'src/new file.ts'))])
      const xml = readXml(root)
      expect(xml).toContain('afterPath="$PROJECT_DIR$/src/new file.ts"')
      expect(xml).not.toContain('beforePath="$PROJECT_DIR$/src/new file.ts"')
      // The self-closing list is now a paired element.
      expect(xml).toMatch(/<list id="empty" name="empty-x" comment="">[\s\S]*<\/list>/)
    } finally {
      removeTree(root)
    }
  })

  it('escapes XML entities and writes a modified row on both sides', async () => {
    const root = makeWorkspace()
    try {
      writeWorkspaceXml(root, MANIFEST)
      const before = await readIdeaChangeLists(root)
      const result = await moveIdeaChangeListFiles(root, {
        from: 'default',
        to: 'empty',
        files: [{ path: resolve(root, 'src/a & b.ts') }],
        expectedMtimeMs: before.mtimeMs!,
      })
      expect(result.lists.find(list => list.id === 'empty')!.files)
        .toEqual([slash(resolve(root, 'src/a & b.ts'))])
      const xml = readXml(root)
      expect(xml).toContain('beforePath="$PROJECT_DIR$/src/a &amp; b.ts"')
      expect(xml).toContain('afterPath="$PROJECT_DIR$/src/a &amp; b.ts"')
    } finally {
      removeTree(root)
    }
  })

  it('refuses a stale answer instead of overwriting the IDE save', async () => {
    const root = makeWorkspace()
    try {
      writeWorkspaceXml(root, MANIFEST)
      const before = await readIdeaChangeLists(root)
      const original = readXml(root)
      await expect(moveIdeaChangeListFiles(root, {
        from: 'default',
        to: 'feature',
        files: [{ path: resolve(root, 'src/other.ts') }],
        expectedMtimeMs: before.mtimeMs! - 1,
      })).rejects.toMatchObject({ code: 'changelist-stale' })
      expect(readXml(root)).toBe(original)
    } finally {
      removeTree(root)
    }
  })

  it('refuses an unknown list and a file owned by a directory change', async () => {
    const root = makeWorkspace()
    try {
      writeWorkspaceXml(root, `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="ChangeListManager">
    <list default="true" id="default" name="Local" comment="">
      <change afterPath="$PROJECT_DIR$/generated" afterDir="true" />
    </list>
    <list id="feature" name="feature-x" comment="" />
  </component>
</project>`)
      const before = await readIdeaChangeLists(root)
      await expect(moveIdeaChangeListFiles(root, {
        from: 'missing', to: 'feature', files: [{ path: resolve(root, 'generated/out.js') }], expectedMtimeMs: before.mtimeMs!,
      })).rejects.toMatchObject({ code: 'not-found' })
      await expect(moveIdeaChangeListFiles(root, {
        from: 'default', to: 'feature', files: [{ path: resolve(root, 'generated/out.js') }], expectedMtimeMs: before.mtimeMs!,
      })).rejects.toMatchObject({ code: 'bad-request' })
      // A directory-owned file has no row to move, so nothing was written.
      expect(readXml(root)).toContain('afterDir="true"')
    } finally {
      removeTree(root)
    }
  })
})

describe('git.changelists route', () => {
  /** Mount the plugin's `/sidebar/api` route against the minimal fake context. */
  function mount(): SidebarWebRoute {
    const routes: SidebarWebRoute[] = []
    const ctx = {
      connection: { requestRejection: () => undefined },
      webServer: {
        register: (route: SidebarWebRoute) => { routes.push(route); return () => {} },
        registerUpgrade: (_route: SidebarWebUpgradeRoute) => () => {},
      },
      sessions: { get: (_id: string) => ({ header: {}, snapshotEvents: () => [] }) },
      tools: { register: () => () => {} },
      effect: (fn: () => void | (() => void)) => { fn() },
      inject: () => () => {},
      on: () => () => {},
      get: () => undefined,
    }
    apply(ctx as never)
    const route = routes.find(entry => entry.path === '/sidebar/api')
    if (route === undefined) throw new Error('the /sidebar/api route was not registered')
    return route
  }

  async function invoke(route: SidebarWebRoute, method: string, payload: unknown): Promise<Record<string, unknown>> {
    const body = Buffer.from(JSON.stringify(payload))
    const req = {
      method: 'POST',
      url: `/sidebar/api/${method}`,
      headers: { host: '127.0.0.1:3080' },
      [Symbol.asyncIterator]: async function* () { yield body },
    } as never
    const out = { body: '' }
    const res = { writeHead: () => {}, end: (chunk: unknown) => { out.body += String(chunk ?? '') } } as never
    await route.handler(req, res)
    return JSON.parse(out.body) as Record<string, unknown>
  }

  it('reads the workspace root .idea and answers its change lists', async () => {
    const root = makeWorkspace()
    try {
      writeWorkspaceXml(root, `
        <component name="ChangeListManager">
          <list default="true" id="default" name="Default Changelist" />
          <list id="feature" name="feature-x">
            <change afterPath="$PROJECT_DIR$/src/app.ts" />
          </list>
        </component>`)
      const answer = await invoke(mount(), 'git.changelists', { sessionId: 'idea-route', cwd: root })
      expect(answer).toMatchObject({
        ok: true,
        value: {
          isIdeaProject: true,
          lists: [
            { id: 'default', name: 'Default Changelist', isDefault: true },
            { id: 'feature', name: 'feature-x', isDefault: false, files: [slash(resolve(root, 'src/app.ts'))] },
          ],
        },
      })
    } finally {
      removeTree(root)
    }
  })

  it('answers a non-IDEA workspace without an error', async () => {
    const root = makeWorkspace()
    try {
      const answer = await invoke(mount(), 'git.changelists', { sessionId: 'idea-route-none', cwd: root })
      expect(answer).toMatchObject({ ok: true, value: { isIdeaProject: false, lists: [] } })
    } finally {
      removeTree(root)
    }
  })

  it('moves a file between lists through the API route', async () => {
    const root = makeWorkspace()
    try {
      writeWorkspaceXml(root, `
        <component name="ChangeListManager">
          <list default="true" id="default" name="Local">
            <change afterPath="$PROJECT_DIR$/src/a.ts" />
          </list>
          <list id="feature" name="feature-x" />
        </component>`)
      const route = mount()
      const read = await invoke(route, 'git.changelists', { sessionId: 'idea-route-move', cwd: root }) as
        { value: { mtimeMs?: number } }
      const answer = await invoke(route, 'git.changelists.move', {
        sessionId: 'idea-route-move',
        cwd: root,
        from: 'default',
        to: 'feature',
        files: [{ path: resolve(root, 'src/a.ts'), status: 'modified' }],
        expectedMtimeMs: read.value.mtimeMs,
      }) as { ok: boolean; value: { lists: Array<{ id: string; files: string[] }> } }
      expect(answer.ok).toBe(true)
      expect(answer.value.lists.find(list => list.id === 'feature')!.files)
        .toEqual([slash(resolve(root, 'src/a.ts'))])
      expect(answer.value.lists.find(list => list.id === 'default')!.files).toEqual([])
    } finally {
      removeTree(root)
    }
  })
})
