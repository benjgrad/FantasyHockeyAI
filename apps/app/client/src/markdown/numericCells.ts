import { isNumericText, numericColumns } from './numeric';

/** The slice of a hast tree this plugin reads (hast is react-markdown's own dependency). */
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/**
 * A rehype plugin: marks table cells `data-num` when their column is numeric (header included,
 * so it aligns with its digits) or the cell itself is a number.
 */
export function rehypeNumericCells() {
  return (tree: HastNode) => {
    visit(tree, (node) => {
      if (node.tagName === 'table') markTable(node);
    });
  };
}

function markTable(table: HastNode): void {
  const rows = elements(table, 'tr');
  const cellsOf = (row: HastNode) =>
    (row.children ?? []).filter((c) => c.tagName === 'td' || c.tagName === 'th');
  const body = rows.filter((r) => cellsOf(r).every((c) => c.tagName === 'td'));
  const numeric = numericColumns(body.map((r) => cellsOf(r).map(textOf)));
  for (const row of rows) {
    cellsOf(row).forEach((cell, i) => {
      const own = cell.tagName === 'td' && isNumericText(textOf(cell));
      if (numeric[i] || own) cell.properties = { ...cell.properties, dataNum: '' };
    });
  }
}

function elements(root: HastNode, tag: string): HastNode[] {
  const out: HastNode[] = [];
  visit(root, (node) => {
    if (node.tagName === tag) out.push(node);
  });
  return out;
}

function textOf(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(textOf).join('');
}

function visit(node: HastNode, fn: (node: HastNode) => void): void {
  fn(node);
  for (const child of node.children ?? []) visit(child, fn);
}
