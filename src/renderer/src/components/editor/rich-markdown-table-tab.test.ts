import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { handleRichMarkdownTableTab } from './rich-markdown-table-tab'

const tableMarkdown = `| A | B |
| --- | --- |
| a1 | b1 |
| a2 | b2 |
`

function createEditor(content = tableMarkdown): Editor {
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

function cellCursorForText(editor: Editor, text: string): number {
  let position: number | null = null
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || node.text !== text) {
      return true
    }
    position = pos
    return false
  })
  if (position === null) {
    throw new Error(`Expected cell text: ${text}`)
  }
  return position
}

function selectionText(editor: Editor): string {
  return editor.state.selection.$from.parent.textContent
}

describe('handleRichMarkdownTableTab', () => {
  it('moves Tab to the next cell', () => {
    const editor = createEditor()
    try {
      editor.commands.setTextSelection(cellCursorForText(editor, 'a1'))
      expect(handleRichMarkdownTableTab(editor, false)).toBe(true)
      expect(selectionText(editor)).toBe('b1')
    } finally {
      editor.destroy()
    }
  })

  it('moves Shift-Tab to the previous cell', () => {
    const editor = createEditor()
    try {
      editor.commands.setTextSelection(cellCursorForText(editor, 'b1'))
      expect(handleRichMarkdownTableTab(editor, true)).toBe(true)
      expect(selectionText(editor)).toBe('a1')
    } finally {
      editor.destroy()
    }
  })

  it('wraps Tab to the next row', () => {
    const editor = createEditor()
    try {
      editor.commands.setTextSelection(cellCursorForText(editor, 'b1'))
      expect(handleRichMarkdownTableTab(editor, false)).toBe(true)
      expect(selectionText(editor)).toBe('a2')
    } finally {
      editor.destroy()
    }
  })

  it('adds a row when Tab is pressed in the last cell', () => {
    const editor = createEditor()
    try {
      const rowsBefore = countTableRows(editor)
      editor.commands.setTextSelection(cellCursorForText(editor, 'b2') + 'b2'.length)
      expect(handleRichMarkdownTableTab(editor, false)).toBe(true)
      expect(countTableRows(editor)).toBe(rowsBefore + 1)
      expect(selectionText(editor)).toBe('')
      expect(editor.isActive('table')).toBe(true)
    } finally {
      editor.destroy()
    }
  })

  it('does not claim Tab outside tables', () => {
    const editor = createEditor('Just a paragraph.\n')
    try {
      editor.commands.setTextSelection(1)
      expect(handleRichMarkdownTableTab(editor, false)).toBe(false)
      expect(handleRichMarkdownTableTab(editor, true)).toBe(false)
    } finally {
      editor.destroy()
    }
  })
})
