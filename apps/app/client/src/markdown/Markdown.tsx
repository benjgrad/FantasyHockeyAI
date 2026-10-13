import { memo, useMemo } from 'react';
import ReactMarkdown, { type Components, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useMatcher } from '../mentions/context';
import { MentionLink, parseMention } from '../mentions/Mention';
import { rehypeMentions } from '../mentions/rehypeMentions';
import { rehypeNumericCells } from './numericCells';
import { safeUrl } from './safeUrl';
import { closeOpenMarkers } from './streaming';

/**
 * Model-written Markdown, rendered inert: raw HTML is dropped (`skipHtml`, and no rehype-raw),
 * links are limited to http(s) and relative URLs and open in a new tab, and images render as
 * their alt text — nothing the model writes can run script or load external content. Player
 * and team names that resolve to one key in the league index open that player's or team's sheet.
 */
export const Markdown = memo(function Markdown({
  text,
  streaming = false,
}: {
  text: string;
  /** The reply is still arriving: close a dangling `**`, backtick or fence before parsing. */
  streaming?: boolean;
}) {
  const source = useMemo(() => (streaming ? closeOpenMarkers(text) : text), [text, streaming]);
  const matcher = useMatcher();
  const rehype = useMemo<Options['rehypePlugins']>(
    () => [rehypeNumericCells, [rehypeMentions, { matcher }]],
    [matcher],
  );
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={REMARK}
        rehypePlugins={rehype}
        components={COMPONENTS}
        skipHtml
        urlTransform={transformUrl}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});

const REMARK = [remarkGfm];

function transformUrl(url: string, key: string): string | null {
  if (key === 'src') return null;
  return safeUrl(url);
}

const COMPONENTS: Components = {
  a: ({ href, children }) =>
    href ? (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-acc underline decoration-acc/40 underline-offset-2 hover:decoration-acc"
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  span: ({ children, node }) => {
    const mention = parseMention(node?.properties?.['dataMention']);
    return mention ? (
      <MentionLink mention={mention}>{children}</MentionLink>
    ) : (
      <span>{children}</span>
    );
  },
  img: ({ alt }) => (alt ? <span className="text-mut italic">[{alt}]</span> : null),
  p: ({ children }) => <p>{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="text-mut">{children}</del>,
  ul: ({ children }) => <ul className="list-disc pl-5">{children}</ul>,
  ol: ({ children, start }) => (
    <ol className="list-decimal pl-5" start={start}>
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  h1: ({ children }) => <h3 className="text-base font-semibold">{children}</h3>,
  h2: ({ children }) => <h3 className="text-base font-semibold">{children}</h3>,
  h3: ({ children }) => <h4 className="text-base font-semibold">{children}</h4>,
  h4: ({ children }) => <h5 className="text-sm font-semibold text-soft">{children}</h5>,
  h5: ({ children }) => <h6 className="tag">{children}</h6>,
  h6: ({ children }) => <h6 className="tag">{children}</h6>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-line pl-3 text-soft">{children}</blockquote>
  ),
  hr: () => <hr className="border-line" />,
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-lg border border-line bg-well p-2 text-xs leading-snug">
      {children}
    </pre>
  ),
  code: ({ className, children }) => (
    <code className={className ? `${className} font-mono` : 'md-code font-mono'}>{children}</code>
  ),
  table: ({ children }) => (
    <div className="scroll-x max-w-full rounded-lg border border-line">
      <table className="md-table w-full border-collapse text-xs tabular-nums">{children}</table>
    </div>
  ),
  th: ({ children, style, node }) => (
    <th style={style} data-num={numAttr(node)}>
      {children}
    </th>
  ),
  td: ({ children, style, node }) => (
    <td style={style} data-num={numAttr(node)}>
      {children}
    </td>
  ),
};

function numAttr(node: { properties?: Record<string, unknown> } | undefined): '' | undefined {
  return node?.properties?.['dataNum'] === undefined ? undefined : '';
}
