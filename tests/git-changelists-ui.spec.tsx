/**
 * The Git lens's IDEA ChangeList grouping.
 *
 * Contract:
 * - the disclosure right above the message box reads `t('commit')` — the pane
 *   is the commit surface, not "changes";
 * - when the workspace's `.idea/workspace.xml` defines named change lists, the
 *   area below the message box renders ONE section per list, default first,
 *   titled with the list's own name;
 * - each section keeps the plain view's merge/staged/unstaged bands, and a
 *   row belongs to exactly one list: the first NAMED list naming it (file or
 *   directory prefix), else the default list — that is the "new changes" rule;
 * - a section's band action touches only that section's rows;
 * - a file row can be dragged onto another ChangeList section, which asks the
 *   host to move it and re-buckets the rows from the answer;
 * - a workspace with no named lists (or no `.idea` at all) keeps the current
 *   plain two/three-band rendering.
 */
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { api, type GitChangeListsResult, type GitStatusResult } from '../src/client/api.ts'
import { GitLens } from '../src/client/changes/GitLens.tsx'
import { t } from '../src/client/locales.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'

setupReactAct()
afterEach(() => { vi.restoreAllMocks() })

const CWD = 'C:/repo'
const FLUSH = async (): Promise<void> => { await act(async () => { await Promise.resolve() }) }

const STATUS: GitStatusResult = {
  isRepo: true,
  branch: 'main',
  root: CWD,
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  entries: [
    { path: 'src/feature.ts', xy: 'M ' },
    { path: 'src/both.ts', xy: 'MM' },
    { path: 'generated/out.js', xy: '??' },
    { path: 'src/other.ts', xy: ' M', unstaged: { additions: 16, deletions: 1 } },
  ],
}

/** Default list first + two named lists, as the host answers them. */
const IDEA_LISTS: GitChangeListsResult = {
  isIdeaProject: true,
  lists: [
    { id: 'default', name: 'Default Changelist', comment: '', isDefault: true, files: [], dirs: [] },
    {
      id: 'feature', name: 'feature-x', comment: 'shipping', isDefault: false,
      files: [`${CWD}/src/feature.ts`, `${CWD}/src/both.ts`],
      dirs: [`${CWD}/generated`],
    },
    { id: 'empty', name: 'empty-list', comment: '', isDefault: false, files: [], dirs: [] },
  ],
}

async function mount(lists: GitChangeListsResult, status: GitStatusResult = STATUS) {
  // A fresh session per mount: the shared git-status store is module-level, so
  // reusing one id would serve the previous test's snapshot instead of the
  // fixture below.
  mountSeq += 1
  vi.spyOn(api, 'gitStatus').mockResolvedValue(status)
  vi.spyOn(api, 'gitChangeLists').mockResolvedValue(lists)
  vi.spyOn(api, 'gitWorktrees').mockResolvedValue([{ path: CWD, branch: 'main', current: true, changes: status.entries.length }])
  vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main'] })
  vi.spyOn(api, 'gitCommitModel').mockResolvedValue({ pinned: false })
  vi.spyOn(api, 'gitGraph').mockResolvedValue({
    isRepo: true, root: CWD, entries: [], branches: [], hasMore: false, snapshot: 'one',
  })
  const view = renderRoot(<GitLens scope={{ sessionId: `scm-idea-${mountSeq}`, cwd: CWD }} visible
    selectedRef={null} onOpenFile={() => {}} onPreview={() => {}} />)
  await FLUSH()
  await FLUSH()
  await FLUSH()
  return view
}
/** Unique session id per mount (see {@link mount}). */
let mountSeq = 0

/** One ChangeList section by the IDE's list id. */
const section = (container: HTMLElement, id: string): HTMLElement | null =>
  container.querySelector<HTMLElement>(`[data-changelist="${id}"]`)

/** One section's header (its own name + count). */
const header = (container: HTMLElement, id: string): HTMLElement => section(container, id)!.firstElementChild as HTMLElement

/** A minimal DataTransfer: jsdom implements neither the drag API nor drag events. */
function makeTransfer(): DataTransfer {
  const store = new Map<string, string>()
  const types: string[] = []
  return {
    get types() { return types },
    effectAllowed: 'all',
    dropEffect: 'none',
    setData(mime: string, value: string) {
      store.set(mime, value)
      if (!types.includes(mime)) types.push(mime)
    },
    getData(mime: string) { return store.get(mime) ?? '' },
  } as unknown as DataTransfer
}

/** Dispatch one native drag event carrying `transfer` (React's synthetic wrapper reads it). */
function fireDrag(
  type: 'dragstart' | 'dragover' | 'dragleave' | 'drop',
  target: Element,
  transfer: DataTransfer,
  relatedTarget: EventTarget | null = null,
): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: transfer })
  Object.defineProperty(event, 'relatedTarget', { value: relatedTarget })
  target.dispatchEvent(event)
}

it('renames the commit surface disclosure to Commit', async () => {
  const view = await mount({ isIdeaProject: false, lists: [] })
  try {
    const disclosure = view.container.querySelector<HTMLButtonElement>('[data-scm-section="changes"] button[aria-expanded]')!
    expect(disclosure.textContent?.trim()).toBe(t('commit'))
    expect(t('commit')).not.toBe(t('gitChanges'))
  } finally { view.unmount() }
})

it('renders every ChangeList in order, the default list first, flattening a single band', async () => {
  const view = await mount(IDEA_LISTS)
  try {
    const { container } = view
    expect([...container.querySelectorAll<HTMLElement>('[data-changelist]')].map(node => node.dataset.changelist))
      .toEqual(['default', 'feature', 'empty'])
    expect(header(container, 'default').textContent).toContain('Default Changelist')
    expect(header(container, 'feature').textContent).toContain('feature-x')
    expect(header(container, 'feature').querySelector('[data-count]')!.textContent).toBe('3')
    expect(header(container, 'default').querySelector('[data-count]')!.textContent).toBe('1')
    // An empty named list is still listed (the IDE defines it), with no bands.
    expect(header(container, 'empty').querySelector('[data-count]')!.textContent).toBe('0')
    expect(section(container, 'empty')!.querySelectorAll('[data-group]')).toHaveLength(0)

    // Membership: matched files leave the default list; unmatched rows stay.
    expect(section(container, 'default')!.querySelector('[data-path="src/other.ts"]')).not.toBeNull()
    expect(section(container, 'default')!.querySelector('[data-path="src/feature.ts"]')).toBeNull()
    expect(section(container, 'feature')!.querySelector('[data-path="src/feature.ts"]')).not.toBeNull()
    expect(section(container, 'feature')!.querySelector('[data-path="src/other.ts"]')).toBeNull()
    // A recorded directory owns every file below it.
    expect(section(container, 'feature')!.querySelector('[data-path="generated/out.js"]')).not.toBeNull()

    // A single-band list is FLAT: no inner "Changes" header, the band's line
    // reading sits on the list header, and its rows hang directly below it.
    expect(section(container, 'default')!.querySelectorAll('[data-group]')).toHaveLength(0)
    expect(header(container, 'default').querySelector('[data-added="16"]')).not.toBeNull()
    expect(header(container, 'default').querySelector('[data-deleted="1"]')).not.toBeNull()

    // A list crossing bands keeps them (and shows no summed header total: the
    // index and worktree readings of one path are never added together).
    expect([...section(container, 'feature')!.querySelectorAll<HTMLElement>('[data-group]')].map(node => node.dataset.group))
      .toEqual(['feature:staged', 'feature:unstaged'])
    expect(header(container, 'feature').querySelector('[data-added]')).toBeNull()
    // 'src/both.ts' is staged AND unstaged: one row in each band.
    expect(section(container, 'feature')!.querySelector('[data-group="feature:staged"] [data-path="src/both.ts"]')).not.toBeNull()
    expect(section(container, 'feature')!.querySelector('[data-group="feature:unstaged"] [data-path="src/both.ts"]')).not.toBeNull()
    expect(section(container, 'feature')!.querySelector('[data-group="feature:unstaged"] [data-path="generated/out.js"]')).not.toBeNull()
  } finally { view.unmount() }
})

it('folds a directory inside a ChangeList section', async () => {
  const view = await mount(IDEA_LISTS)
  try {
    const { container } = view
    // Single-band list: the directory row hangs directly under the list.
    const defaultDir = section(container, 'default')!.querySelector<HTMLButtonElement>('[data-dir="src"]')!
    await act(async () => { defaultDir.click() })
    expect(defaultDir.getAttribute('aria-expanded')).toBe('false')
    expect(section(container, 'default')!.querySelector('[data-path="src/other.ts"]')).toBeNull()
    await act(async () => { defaultDir.click() })
    expect(defaultDir.getAttribute('aria-expanded')).toBe('true')
    expect(section(container, 'default')!.querySelector('[data-path="src/other.ts"]')).not.toBeNull()

    // A multi-band list: folding its directory must not fold another list's.
    const featureDir = section(container, 'feature')!.querySelector<HTMLButtonElement>('[data-dir="generated"]')!
    await act(async () => { featureDir.click() })
    expect(featureDir.getAttribute('aria-expanded')).toBe('false')
    expect(section(container, 'feature')!.querySelector('[data-path="generated/out.js"]')).toBeNull()
    expect(section(container, 'default')!.querySelector('[data-path="src/other.ts"]')).not.toBeNull()
    await act(async () => { featureDir.click() })
    expect(section(container, 'feature')!.querySelector('[data-path="generated/out.js"]')).not.toBeNull()
  } finally { view.unmount() }
})

it('scopes a section band action to that ChangeList only', async () => {
  const view = await mount(IDEA_LISTS)
  const stage = vi.spyOn(api, 'gitStage').mockResolvedValue({ ok: true })
  try {
    const { container } = view
    const stageAll = section(container, 'feature')!
      .querySelector<HTMLButtonElement>('[data-group="feature:unstaged"] button[aria-label="' + t('stageAll') + '"]')!
    await act(async () => { stageAll.click() })
    await FLUSH()
    expect(stage.mock.calls.map(call => call[1])).toEqual(['src/both.ts', 'generated/out.js'])

    stage.mockClear()
    // The default list is single-band, so its all-action lives on the list
    // header (the inner band header is not drawn).
    const defaultStageAll = section(container, 'default')!.firstElementChild!
      .querySelector<HTMLButtonElement>(`button[aria-label="${t('stageAll')}"]`)!
    await act(async () => { defaultStageAll.click() })
    await FLUSH()
    expect(stage.mock.calls.map(call => call[1])).toEqual(['src/other.ts'])
  } finally { view.unmount() }
})

it('keeps the plain groups when the workspace has no named ChangeList', async () => {
  const onlyDefault: GitChangeListsResult = {
    isIdeaProject: true,
    lists: [{ id: 'default', name: 'Default Changelist', comment: '', isDefault: true, files: [], dirs: [] }],
  }
  const view = await mount(onlyDefault)
  try {
    const { container } = view
    expect(container.querySelector('[data-changelist]')).toBeNull()
    expect([...container.querySelectorAll<HTMLElement>('[data-group]')].map(node => node.dataset.group))
      .toEqual(['staged', 'unstaged'])
    // The heading still carries the Commit label in the fallback view.
    expect(container.querySelector('[data-scm-section="changes"] button[aria-expanded]')!.textContent?.trim())
      .toBe(t('commit'))
  } finally { view.unmount() }
})

it('keeps the plain groups on a non-IDEA workspace', async () => {
  const view = await mount({ isIdeaProject: false, lists: [] })
  try {
    expect(view.container.querySelector('[data-changelist]')).toBeNull()
    expect([...view.container.querySelectorAll<HTMLElement>('[data-group]')].map(node => node.dataset.group))
      .toEqual(['staged', 'unstaged'])
    // No ChangeList sections means no drop targets to drag onto.
    expect(view.container.querySelector('[data-row][draggable="true"]')).toBeNull()
  } finally { view.unmount() }
})

it('moves a dragged file between ChangeList sections and re-buckets it', async () => {
  const view = await mount(IDEA_LISTS)
  const moved: GitChangeListsResult = {
    isIdeaProject: true,
    mtimeMs: 123,
    lists: IDEA_LISTS.lists.map(list => (list.id === 'feature'
      ? { ...list, files: [...list.files, `${CWD}/src/other.ts`] }
      : list.id === 'default' ? { ...list, files: [] } : list)),
  }
  const move = vi.spyOn(api, 'gitMoveChangeListFile').mockResolvedValue(moved)
  try {
    const { container } = view
    const row = section(container, 'default')!.querySelector<HTMLElement>('[data-row="src/other.ts"]')!
    expect(row.getAttribute('draggable')).toBe('true')
    const transfer = makeTransfer()
    await act(async () => { fireDrag('dragstart', row, transfer) })
    expect(transfer.types).toContain('application/x-dsh-changelist-file')

    // Dropping on the source list is a no-op (and never asks the host).
    await act(async () => { fireDrag('drop', header(container, 'default'), transfer) })
    await FLUSH()
    expect(move).not.toHaveBeenCalled()

    const targetHeader = header(container, 'feature')
    await act(async () => { fireDrag('dragover', targetHeader, transfer) })
    expect(section(container, 'feature')!.getAttribute('data-drop-target')).toBe('true')
    await act(async () => { fireDrag('drop', targetHeader, transfer) })
    await FLUSH()

    expect(move).toHaveBeenCalledTimes(1)
    const [scope, request] = move.mock.calls[0]!
    expect(scope.sessionId).toMatch(/^scm-idea-/)
    expect(request).toMatchObject({
      from: 'default',
      to: 'feature',
      files: [{ path: `${CWD}/src/other.ts`, status: 'modified' }],
    })
    // The answer re-buckets the rows: the file is gone from the default list
    // and appears under the target, whose header count follows.
    expect(section(container, 'default')!.querySelector('[data-path="src/other.ts"]')).toBeNull()
    expect(header(container, 'default').querySelector('[data-count]')!.textContent).toBe('0')
    expect(section(container, 'feature')!.querySelector('[data-path="src/other.ts"]')).not.toBeNull()
    expect(header(container, 'feature').querySelector('[data-count]')!.textContent).toBe('4')
    expect(section(container, 'feature')!.getAttribute('data-drop-target')).toBeNull()
  } finally { view.unmount() }
})

it('drags a directory and moves its whole subtree across bands', async () => {
  const view = await mount(IDEA_LISTS)
  const moved: GitChangeListsResult = {
    isIdeaProject: true,
    mtimeMs: 456,
    lists: IDEA_LISTS.lists.map(list => (list.id === 'feature'
      // src files leave the list; the recorded generated/ dir stays.
      ? { ...list, files: [], dirs: [`${CWD}/generated`] }
      : list)),
  }
  const move = vi.spyOn(api, 'gitMoveChangeListFile').mockResolvedValue(moved)
  try {
    const { container } = view
    const dirButton = section(container, 'feature')!.querySelector<HTMLElement>('[data-dir="src"]')!
    const dirRow = dirButton.closest<HTMLElement>('[data-row]')!
    expect(dirRow.getAttribute('draggable')).toBe('true')
    const transfer = makeTransfer()
    await act(async () => { fireDrag('dragstart', dirRow, transfer) })
    await act(async () => { fireDrag('drop', header(container, 'default'), transfer) })
    await FLUSH()

    expect(move).toHaveBeenCalledTimes(1)
    expect(move.mock.calls[0]![1]).toMatchObject({
      from: 'feature',
      to: 'default',
      // feature.ts is staged only; both.ts is staged AND unstaged (one file).
      files: [
        { path: `${CWD}/src/feature.ts`, status: 'modified' },
        { path: `${CWD}/src/both.ts`, status: 'modified' },
      ],
    })
    expect(section(container, 'default')!.querySelector('[data-path="src/feature.ts"]')).not.toBeNull()
    expect(section(container, 'default')!.querySelector('[data-path="src/both.ts"]')).not.toBeNull()
    expect(section(container, 'feature')!.querySelector('[data-path="src/feature.ts"]')).toBeNull()
    expect(section(container, 'feature')!.querySelector('[data-path="src/both.ts"]')).toBeNull()
    // The generated/ directory entry still owns its file.
    expect(section(container, 'feature')!.querySelector('[data-path="generated/out.js"]')).not.toBeNull()
  } finally { view.unmount() }
})

it('matches IDEA paths case-insensitively on a Windows root', async () => {
  const lists: GitChangeListsResult = {
    isIdeaProject: true,
    lists: [
      { id: 'default', name: 'Default Changelist', comment: '', isDefault: true, files: [], dirs: [] },
      {
        id: 'windows', name: 'windows-list', comment: '', isDefault: false,
        files: ['C:/REPO/SRC/Feature.TS'], dirs: [],
      },
    ],
  }
  const view = await mount(lists)
  try {
    expect(section(view.container, 'windows')!.querySelector('[data-path="src/feature.ts"]')).not.toBeNull()
    expect(section(view.container, 'default')!.querySelector('[data-path="src/feature.ts"]')).toBeNull()
  } finally { view.unmount() }
})
