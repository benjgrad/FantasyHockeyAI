import { memo, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { rehypeNumericCells } from './numericCells';
import { safeUrl } from './safeUrl';
import { closeOpenMarkers } from './streaming';

/**
 * Model-written Markdown, rendered inert: raw HTML is dropped (`skipHtml`, and no rehype-raw),
 * links are limited to http(s) and relative URLs and open in a new tab, and images render as
 * their alt text — nothing the model writes can run script or load external content.
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
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={REMARK}
        rehypePlugins={REHYPE}
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
const REHYPE = [rehypeNumericCells];

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
  h3: ({ children }) => <h4 className="text-[15px] font-semibold">{children}</h4>,
  h4: ({ children }) => <h5 className="text-sm font-semibold text-soft">{children}</h5>,
  h5: ({ children }) => <h6 className="tag">{children}</h6>,
  h6: ({ children }) => <h6 className="tag">{children}</h6>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-line pl-3 text-soft">{children}</blockquote>
  ),
  hr: () => <hr className="border-line" />,
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-lg border border-line bg-well p-2 text-[13px] leading-snug">
      {children}
    </pre>
  ),
  code: ({ className, children }) => (
    <code className={className ? `${className} font-mono` : 'md-code font-mono'}>{children}</code>
  ),
  table: ({ children }) => (
    <div className="max-w-full overflow-x-auto rounded-lg border border-line">
      <table className="md-table w-full border-collapse text-[13px] tabular-nums">{children}</table>
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
