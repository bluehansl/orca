import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor
} from './helpers/markdown-ordered-list-exit'

const TABLE_MARKDOWN = `| Name | Value |
| --- | --- |
| keep | a |
|  |  |
| stay | c |
`

const SCRATCH_DIR =
  process.env.ORCA_TABLE_ROW_BACKSPACE_SCREENSHOT_DIR ??
  path.join(process.cwd(), 'test-results', 'table-row-backspace')

test.describe('Markdown table empty-row Backspace', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('Backspace on an empty body row deletes the whole row', async ({ orcaPage }, testInfo) => {
    const context = await getActiveWorktreeContext(orcaPage)
    let filePath: string | null = null

    try {
      filePath = await createMarkdownFixture(
        context,
        'table-row-backspace',
        testInfo.workerIndex,
        TABLE_MARKDOWN
      )
      await openMarkdownFixture(orcaPage, context, filePath)
      const editor = await waitForRichMarkdownEditor(orcaPage)

      await expect(editor.locator('tr')).toHaveCount(4, { timeout: 10_000 })
      await expect(editor.getByText('keep')).toBeVisible()
      await expect(editor.getByText('stay')).toBeVisible()

      // Place caret in the empty body row (third data row after header).
      await orcaPage.evaluate(() => {
        const editorRoot = document.querySelector('.rich-markdown-editor')
        if (!editorRoot) {
          throw new Error('Rich markdown editor was not mounted')
        }
        const rows = Array.from(editorRoot.querySelectorAll('tr'))
        const emptyRow = rows.find((row) => {
          const cells = Array.from(row.querySelectorAll('td, th'))
          return (
            cells.length > 0 &&
            cells.every((cell) => (cell.textContent ?? '').trim().length === 0) &&
            row.querySelector('td') != null
          )
        })
        if (!emptyRow) {
          throw new Error('Expected an empty body table row')
        }
        const textblock = emptyRow.querySelector('p') ?? emptyRow.querySelector('td')
        if (!textblock) {
          throw new Error('Expected a caret target in the empty row')
        }
        const selection = window.getSelection()
        if (!selection) {
          throw new Error('window.getSelection() is unavailable')
        }
        const range = document.createRange()
        range.selectNodeContents(textblock)
        range.collapse(true)
        selection.removeAllRanges()
        selection.addRange(range)
        ;(textblock as HTMLElement).focus?.()
        editorRoot.dispatchEvent(new Event('focusin', { bubbles: true }))
      })

      await editor.screenshot({
        path: path.join(SCRATCH_DIR, 'electron-table-row-backspace-before.png')
      })
      await orcaPage.screenshot({
        path: path.join(SCRATCH_DIR, 'electron-table-row-backspace-before-window.png')
      })

      await orcaPage.keyboard.press('Backspace')

      await expect
        .poll(
          async () =>
            orcaPage.evaluate(() => {
              const editorRoot = document.querySelector('.rich-markdown-editor')
              if (!editorRoot) {
                return -1
              }
              return editorRoot.querySelectorAll('tr').length
            }),
          {
            timeout: 5_000,
            message: 'Empty body row should be removed after Backspace'
          }
        )
        .toBe(3)

      await expect(editor.getByText('keep')).toBeVisible()
      await expect(editor.getByText('stay')).toBeVisible()

      await editor.screenshot({
        path: path.join(SCRATCH_DIR, 'electron-table-row-backspace-after.png')
      })
      await orcaPage.screenshot({
        path: path.join(SCRATCH_DIR, 'electron-table-row-backspace-after-window.png')
      })
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })
})
