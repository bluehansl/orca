import type { Editor } from '@tiptap/react'
import { TextSelection } from '@tiptap/pm/state'
import { isInTable, moveCellForward, nextCell, selectionCell } from '@tiptap/pm/tables'

function moveToVerticalNeighbor(editor: Editor, direction: 1 | -1): boolean {
  const { state, view } = editor
  const $cell = selectionCell(state)
  const $nextCell = $cell ? nextCell($cell, 'vert', direction) : null
  if (!$nextCell) {
    return false
  }

  view.dispatch(
    state.tr
      .setSelection(TextSelection.between($nextCell, moveCellForward($nextCell)))
      .scrollIntoView()
  )
  return true
}

/**
 * BlockNote-style table Enter: move to the cell below instead of inserting a
 * paragraph (GFM tables don't represent multi-line cells cleanly).
 * Returns true when the key should be consumed inside a table.
 *
 * Reference: TypeCellOS/BlockNote packages/core/src/blocks/Table/TableExtension.ts
 * Last-row growth matches Outline's add-row-on-boundary pattern.
 */
export function handleRichMarkdownTableEnter(editor: Editor): boolean {
  if (!isInTable(editor.state)) {
    return false
  }

  if (moveToVerticalNeighbor(editor, 1)) {
    return true
  }

  // Why: last-row Enter grows the table rather than inserting an in-cell hard
  // break that GFM serialization cannot keep.
  if (!editor.can().addRowAfter()) {
    return true
  }

  editor.commands.addRowAfter()
  // Selection stays in the original row; step down into the new one.
  moveToVerticalNeighbor(editor, 1)
  return true
}
