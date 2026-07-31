import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import {
  deleteEmptyTableRowOnBackspace,
  handleRichMarkdownTableBackspace
} from './rich-markdown-table-row-delete'

const multiRowTableMarkdown = `| Name | Value |
| --- | --- |
| keep | a |
| drop | b |
| stay | c |
`

function createEditor(content: string): Editor {
  return new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content,
    contentType: 'markdown'
  })
}

function countTableRows(editor: Editor): number {
  let count = 0
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'tableRow') {
      count += 1
    }
  })
  return count
}

function hasTable(editor: Editor): boolean {
  let found = false
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'table') {
      found = true
      return false
    }
    return true
  })
  return found
}

function firstCellCursorInRowContaining(editor: Editor, text: string): number {
  let position: number | null = null
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'tableRow' || !node.textContent.includes(text)) {
      return true
    }
    // tableRow → tableCell → paragraph → textblock start
    position = pos + 1 + 1 + 1
    return false
  })

  if (position === null) {
    throw new Error(`Expected a table row containing: ${text}`)
  }

  return position
}

function firstEmptyBodyRowCursor(editor: Editor): number {
  let position: number | null = null
  let sawHeaderRow = false

  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'tableRow') {
      return true
    }

    if (!sawHeaderRow) {
      sawHeaderRow = true
      return true
    }

    const empty = Array.from({ length: node.childCount }, (_, index) => node.child(index)).every(
      (cell) => cell.textContent.length === 0
    )
    if (!empty) {
      return true
    }

    // tableRow → tableCell → paragraph → empty textblock start
    position = pos + 1 + 1 + 1
    return false
  })

  if (position === null) {
    throw new Error('Expected an empty body table row')
  }

  return position
}

function clearRowContaining(editor: Editor, text: string): void {
  const targets: { from: number; to: number }[] = []
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'tableRow' || !node.textContent.includes(text)) {
      return true
    }

    for (let index = 0; index < node.childCount; index += 1) {
      const cell = node.child(index)
      let offset = pos + 1
      for (let before = 0; before < index; before += 1) {
        offset += node.child(before).nodeSize
      }
      // Replace cell interior (skip cell open, leave cell structure)
      targets.push({ from: offset + 1, to: offset + cell.nodeSize - 1 })
    }
    return false
  })

  if (targets.length === 0) {
    throw new Error(`Expected a table row containing: ${text}`)
  }

  // Delete from the end so earlier positions stay valid
  let { tr } = editor.state
  for (const target of targets.toReversed()) {
    tr = tr.delete(target.from, target.to)
    const emptyParagraph = editor.schema.nodes.paragraph.create()
    tr = tr.insert(target.from, emptyParagraph)
  }
  editor.view.dispatch(tr)
}

describe('deleteEmptyTableRowOnBackspace', () => {
  it('deletes an empty body row and leaves sibling rows intact', () => {
    const editor = createEditor(multiRowTableMarkdown)

    try {
      expect(countTableRows(editor)).toBe(4)
      clearRowContaining(editor, 'drop')
      expect(editor.getMarkdown()).not.toContain('drop')
      expect(editor.getMarkdown()).toContain('keep')

      editor.commands.setTextSelection(firstEmptyBodyRowCursor(editor))
      expect(deleteEmptyTableRowOnBackspace(editor)).toBe(true)

      expect(countTableRows(editor)).toBe(3)
      const markdown = editor.getMarkdown()
      expect(markdown).toContain('keep')
      expect(markdown).toContain('stay')
      expect(markdown).not.toContain('drop')
      expect(markdown).toContain('| Name')
      expect(hasTable(editor)).toBe(true)
    } finally {
      editor.destroy()
    }
  })

  it('removes the whole table when the last remaining row is empty', () => {
    const editor = createEditor(`| Only |
| --- |
| x |
`)

    try {
      clearRowContaining(editor, 'x')
      // Also clear the header so only empty rows remain, then delete body,
      // then delete the last (header) row → table gone.
      clearRowContaining(editor, 'Only')
      expect(countTableRows(editor)).toBe(2)

      editor.commands.setTextSelection(firstEmptyBodyRowCursor(editor))
      expect(deleteEmptyTableRowOnBackspace(editor)).toBe(true)
      expect(countTableRows(editor)).toBe(1)

      // Last remaining empty row → deleteTable
      editor.commands.setTextSelection(firstCellCursorInRowContaining(editor, ''))
      // After body delete, the only row is the empty header; place caret inside it
      let lastRowPos: number | null = null
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'tableRow') {
          lastRowPos = pos + 1 + 1 + 1
          return false
        }
        return true
      })
      if (lastRowPos === null) {
        throw new Error('Expected a remaining table row')
      }
      editor.commands.setTextSelection(lastRowPos)
      expect(deleteEmptyTableRowOnBackspace(editor)).toBe(true)

      expect(hasTable(editor)).toBe(false)
      expect(editor.getMarkdown()).not.toMatch(/\|/)
    } finally {
      editor.destroy()
    }
  })

  it('deletes the table when a single-row empty table receives Backspace', () => {
    const editor = createEditor(`| a | b |
| --- | --- |
`)

    try {
      // Clear header cells so the only row is empty
      clearRowContaining(editor, 'a')
      // Single row tables: header only after parse? GFM often keeps header + empty body.
      // Force last-row path by deleting until one empty row remains, or use insertTable.
      while (countTableRows(editor) > 1) {
        let pos: number | null = null
        editor.state.doc.descendants((node, p) => {
          if (node.type.name === 'tableRow') {
            pos = p + 1 + 1 + 1
            return false
          }
          return true
        })
        if (pos === null) {
          break
        }
        editor.commands.setTextSelection(pos)
        // Prefer deleteRow while multiple rows remain
        if (countTableRows(editor) > 1) {
          editor.commands.deleteRow()
        }
      }

      let caret: number | null = null
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'tableRow') {
          caret = pos + 1 + 1 + 1
          return false
        }
        return true
      })
      if (caret === null) {
        throw new Error('Expected a table row')
      }
      editor.commands.setTextSelection(caret)

      // Ensure the remaining row is empty
      const rowEmpty = (() => {
        let empty = false
        editor.state.doc.descendants((node) => {
          if (node.type.name === 'tableRow') {
            empty = Array.from({ length: node.childCount }, (_, i) => node.child(i)).every(
              (cell) => cell.textContent.length === 0
            )
            return false
          }
          return true
        })
        return empty
      })()
      expect(rowEmpty).toBe(true)
      expect(countTableRows(editor)).toBe(1)

      expect(deleteEmptyTableRowOnBackspace(editor)).toBe(true)
      expect(hasTable(editor)).toBe(false)
      expect(editor.getMarkdown().includes('|')).toBe(false)
    } finally {
      editor.destroy()
    }
  })

  it('does not hijack Backspace when the current cell still has content', () => {
    const editor = createEditor(multiRowTableMarkdown)

    try {
      const pos = firstCellCursorInRowContaining(editor, 'keep')
      editor.commands.setTextSelection(pos)
      // Caret is at start of "keep" — content remains, so structural delete must no-op
      expect(deleteEmptyTableRowOnBackspace(editor)).toBe(false)
      expect(countTableRows(editor)).toBe(4)
      expect(editor.getMarkdown()).toContain('keep')
      expect(editor.getMarkdown()).toContain('drop')
    } finally {
      editor.destroy()
    }
  })

  it('does not delete a row when only the current cell is empty', () => {
    const editor = createEditor(multiRowTableMarkdown)

    try {
      // Clear only the first cell of the "drop" row
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name !== 'tableRow' || !node.textContent.includes('drop')) {
          return true
        }
        const cell = node.child(0)
        const cellPos = pos + 1
        const tr = editor.state.tr
          .delete(cellPos + 1, cellPos + cell.nodeSize - 1)
          .insert(cellPos + 1, editor.schema.nodes.paragraph.create())
        editor.view.dispatch(tr)
        return false
      })

      editor.commands.setTextSelection(firstCellCursorInRowContaining(editor, 'b'))
      // Move to the empty first cell of that row
      let emptyCellPos: number | null = null
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name !== 'tableRow' || !node.textContent.includes('b')) {
          return true
        }
        emptyCellPos = pos + 1 + 1 + 1
        return false
      })
      if (emptyCellPos === null) {
        throw new Error('Expected partially empty row')
      }
      editor.commands.setTextSelection(emptyCellPos)

      expect(deleteEmptyTableRowOnBackspace(editor)).toBe(false)
      expect(countTableRows(editor)).toBe(4)
      expect(editor.getMarkdown()).toContain('b')
    } finally {
      editor.destroy()
    }
  })

  it('moves Backspace from an empty cell to the previous cell without deleting the row', () => {
    const editor = createEditor(multiRowTableMarkdown)

    try {
      // Clear only the Value cell of the "drop" row ("b")
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name !== 'tableRow' || !node.textContent.includes('drop')) {
          return true
        }
        const cell = node.child(1)
        let offset = pos + 1 + node.child(0).nodeSize
        const tr = editor.state.tr
          .delete(offset + 1, offset + cell.nodeSize - 1)
          .insert(offset + 1, editor.schema.nodes.paragraph.create())
        editor.view.dispatch(tr)
        return false
      })

      // Caret in the emptied "b" cell
      let emptyValuePos: number | null = null
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name !== 'tableRow' || !node.textContent.includes('drop')) {
          return true
        }
        emptyValuePos = pos + 1 + node.child(0).nodeSize + 1 + 1
        return false
      })
      if (emptyValuePos === null) {
        throw new Error('Expected emptied value cell')
      }
      editor.commands.setTextSelection(emptyValuePos)

      expect(handleRichMarkdownTableBackspace(editor)).toBe(true)
      expect(countTableRows(editor)).toBe(4)
      expect(editor.state.selection.$from.parent.textContent).toBe('drop')
      expect(editor.getMarkdown()).toContain('drop')
    } finally {
      editor.destroy()
    }
  })

  it('does not hijack Backspace outside tables', () => {
    const editor = createEditor('Just a paragraph.\n')

    try {
      editor.commands.setTextSelection(1)
      expect(deleteEmptyTableRowOnBackspace(editor)).toBe(false)
      expect(editor.getMarkdown()).toContain('Just a paragraph')
    } finally {
      editor.destroy()
    }
  })
})
