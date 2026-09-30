/**
 * Closes Markdown markers left open by a reply that is still streaming, so a half-written
 * `**bold`, `` `code `` or code fence renders as the finished thing would rather than flashing
 * literal asterisks. Applied to the streaming text only; a finished turn renders verbatim.
 */
export function closeOpenMarkers(text: string): string {
  const fences = text.match(/^ {0,3}(```|~~~)/gm) ?? [];
  if (fences.length % 2 === 1) {
    const opener = fences[fences.length - 1]?.trim() ?? '```';
    return `${text.endsWith('\n') ? text : `${text}\n`}${opener}`;
  }
  const cut = lastBlockStart(text);
  const head = text.slice(0, cut);
  let block = text.slice(cut);
  if (countUnescaped(block, '`') % 2 === 1) block = `${block.trimEnd()}\``;
  const bare = block.replace(/`[^`]*`/g, '');
  if (countUnescaped(bare, '**') % 2 === 1) {
    const dangling = /\*\*\s*$/.exec(block);
    block = dangling ? block.slice(0, dangling.index) : `${block.trimEnd()}**`;
  }
  return head + block;
}

/** Where the last paragraph begins: markers never span a blank line. */
function lastBlockStart(text: string): number {
  const at = text.search(/\n[ \t]*\n(?![\s\S]*\n[ \t]*\n)/);
  return at === -1 ? 0 : at;
}

function countUnescaped(text: string, marker: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\\') {
      i += 1;
      continue;
    }
    if (text.startsWith(marker, i)) {
      count += 1;
      i += marker.length - 1;
    }
  }
  return count;
}
