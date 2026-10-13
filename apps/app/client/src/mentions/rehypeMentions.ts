import { findMentions, type Matcher } from './match';

/** The slice of a hast tree this plugin reads and writes. */
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** Text under these is left as written: code is literal, and a link already goes somewhere. */
const SKIP = new Set(['code', 'pre', 'a']);

/**
 * A rehype plugin: wraps each player and team name in a `span[data-mention="kind:key"]`, which
 * the Markdown renderer turns into a link to that sheet. The whole message is matched at once,
 * so a surname links anywhere in a reply that names the player in full.
 */
export function rehypeMentions(opts: { matcher: Matcher | null }) {
  return (tree: HastNode) => {
    const { matcher } = opts;
    if (matcher?.pattern == null) return;
    const texts: HastNode[] = [];
    collect(tree, texts);
    const segs = findMentions(
      texts.map((t) => t.value ?? ''),
      matcher,
    );
    const replace = new Map(texts.map((t, i) => [t, segs[i] ?? []]));
    rewrite(tree, replace);
  };
}

function collect(node: HastNode, out: HastNode[]): void {
  if (node.type === 'text') out.push(node);
  if (node.tagName !== undefined && SKIP.has(node.tagName)) return;
  for (const child of node.children ?? []) collect(child, out);
}

function rewrite(node: HastNode, replace: Map<HastNode, ReturnType<typeof findMentions>[number]>) {
  if (node.children === undefined) return;
  node.children = node.children.flatMap((child) => {
    const segs = replace.get(child);
    if (segs === undefined) {
      rewrite(child, replace);
      return [child];
    }
    return segs.map((s) =>
      typeof s === 'string'
        ? { type: 'text', value: s }
        : {
            type: 'element',
            tagName: 'span',
            properties: { dataMention: `${s.mention.kind}:${s.mention.key}` },
            children: [{ type: 'text', value: s.text }],
          },
    );
  });
}
