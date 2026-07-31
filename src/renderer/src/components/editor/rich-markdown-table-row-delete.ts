import type { Editor } from '@tiptap/react'
import type { Node as PmNode, ResolvedPos } from '@tiptap/pm/model'

const TABLE_CELL_TYPES = new Set(['tableCell', 'tableHeader'])

function isEmptyTableCell(cell: PmNode): boolean {
  return cell.textContent.length === 0
}

function isEmptyTableRow(row: PmNode): boolean {
  for (let index = 0; index < row.childCount; index += 1) {
    if (!isEmptyTableCell(row.child(index))) {
      return false
    }
  }
  return row.childCount > 0
}

function findTableContext($from: ResolvedPos): {
  cellDepth: number
  rowDepth: number
  tableDepth: number
} | null {
  let cellDepth = -1
  let rowDepth = -1
  let tableDepth = -1

  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const name = $from.node(depth).type.name
    if (cellDepth < 0 && TABLE_CELL_TYPES.has(name)) {
      cellDepth = depth
    } else if (rowDepth < 0 && name === 'tableRow') {
      rowDepth = depth
    } else if (tableDepth < 0 && name === 'table') {
      tableDepth = depth
    }
  }

  if (cellDepth < 0 || rowDepth < 0 || tableDepth < 0) {
    return null
  }

  return { cellDepth, rowDepth, tableDepth }
}

/**
 * Notion-like: Backspace on a fully empty table row removes the row
 * (or the whole table when it is the last remaining row).
 */
export function deleteEmptyTableRowOnBackspace(editor: Editor): boolean {
  const { selection } = editor.state
  if (!selection.empty) {
    return false
  }

  const { $from } = selection
  if (!$from.parent.isTextblock || $from.parentOffset !== 0) {
    return false
  }

  const context = findTableContext($from)
  if (!context) {
    return false
  }

  const cell = $from.node(context.cellDepth)
  if (!isEmptyTableCell(cell)) {
    return false
  }

  const row = $from.node(context.rowDepth)
  if (!isEmptyTableRow(row)) {
    return false
  }

  const table = $from.node(context.tableDepth)
  // Why: prosemirror-tables deleteRow refuses when the selection spans the
  // only remaining row; deleteTable is the correct last-row exit.
  if (table.childCount <= 1) {
    return editor.commands.deleteTable()
  }

  return editor.commands.deleteRow()
}
