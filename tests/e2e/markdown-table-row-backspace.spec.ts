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

// Middle body row starts empty so Backspace can structural-delete without
// relying on Meta+A (which selects the whole document in TipTap).
const TABLE_MARKDOWN = `| Name | Value |
| --- | --- |
| keep | a |
|  |  |
| stay | c |
`

const SCRATCH_DIR =
  process.env.ORCA_TABLE_ROW_BACKSPACE_SCREENSHOT_DIR ??
  path.join(process.cwd(), 'test-results', 'table-row-backspace')

async function placeCaretInCellWithText(
  page: {
    evaluate: (fn: (text: string) => void, text: string) => Promise<void>
  },
  text: string
): Promise<void> {
  await page.evaluate((cellText) => {
    const editorRoot = document.querySelector('.rich-markdown-editor')
    if (!editorRoot) {
      throw new Error('Rich markdown editor was not mounted')
    }

    const walker = document.createTreeWalker(editorRoot, NodeFilter.SHOW_TEXT)
    let textNode: Text | null = null
    while (walker.nextNode()) {
      const node = walker.currentNode as Text
      if (node.textContent === cellText && node.parentElement?.closest('td, th')) {
        textNode = node
        break
      }
    }
    if (!textNode) {
      throw new Error(`Expected table cell text: ${cellText}`)
    }

    const selection = window.getSelection()
    if (!selection) {
      throw new Error('window.getSelection() is unavailable')
    }
    const range = document.createRange()
    range.setStart(textNode, 0)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    editorRoot.dispatchEvent(new Event('focusin', { bubbles: true }))
  }, text)
}

async function placeCaretInEmptyBodyRow(page: {
  evaluate: (fn: () => void) => Promise<void>
}): Promise<void> {
  await page.evaluate(() => {
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
}

async function selectionCellText(page: {
  evaluate: (fn: () => string | null) => Promise<string | null>
}): Promise<string | null> {
  return page.evaluate(() => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) {
      return null
    }
    const node = selection.anchorNode
    if (!node) {
      return null
    }
    const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
    const cell = element?.closest('td, th')
    return cell?.textContent?.trim() ?? null
  })
}

async function tableRowCount(page: {
  evaluate: (fn: () => number) => Promise<number>
}): Promise<number> {
  return page.evaluate(() => {
    const editorRoot = document.querySelector('.rich-markdown-editor')
    if (!editorRoot) {
      return -1
    }
    return editorRoot.querySelectorAll('tr').length
  })
}

test.describe('Markdown table keyboard', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('Tab/Shift-Tab move between cells and empty-row Backspace deletes the row', async ({
    orcaPage
  }, testInfo) => {
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

      // ── Tab / Shift-Tab cell navigation ────────────────────────────
      await editor.click()
      await placeCaretInCellWithText(orcaPage, 'keep')

      await orcaPage.keyboard.press('Tab')
      await expect
        .poll(async () => selectionCellText(orcaPage), {
          timeout: 5_000,
          message: 'Tab should move from keep → a'
        })
        .toBe('a')

      // Next Tab lands in the empty body row (no text).
      await orcaPage.keyboard.press('Tab')
      await expect
        .poll(async () => selectionCellText(orcaPage), {
          timeout: 5_000,
          message: 'Tab should wrap into the empty body row'
        })
        .toBe('')

      await orcaPage.keyboard.press('Shift+Tab')
      await expect
        .poll(async () => selectionCellText(orcaPage), {
          timeout: 5_000,
          message: 'Shift-Tab should return to previous cell (a)'
        })
        .toBe('a')

      // Enter moves down a column, landing in the empty body row.
      await orcaPage.keyboard.press('Enter')
      await expect
        .poll(async () => selectionCellText(orcaPage), {
          timeout: 5_000,
          message: 'Enter should move down into the empty body row'
        })
        .toBe('')

      // ── Empty-row Backspace deletes the whole row ──────────────────
      await placeCaretInEmptyBodyRow(orcaPage)

      await editor.screenshot({
        path: path.join(SCRATCH_DIR, 'electron-table-row-backspace-before.png')
      })
      await orcaPage.screenshot({
        path: path.join(SCRATCH_DIR, 'electron-table-row-backspace-before-window.png')
      })

      await orcaPage.keyboard.press('Backspace')

      await expect
        .poll(async () => tableRowCount(orcaPage), {
          timeout: 5_000,
          message: 'Empty body row should be removed after Backspace'
        })
        .toBe(3)

      await expect(editor.getByText('keep')).toBeVisible()
      await expect(editor.getByText('stay')).toBeVisible()

      await editor.screenshot({
        path: path.join(SCRATCH_DIR, 'electron-table-row-backspace-after.png')
      })
      await orcaPage.screenshot({
        path: path.join(SCRATCH_DIR, 'electron-table-row-backspace-after-window.png')
      })

      // Hold a beat so the video recording captures the final table state.
      await orcaPage.waitForTimeout(800)
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })
})
