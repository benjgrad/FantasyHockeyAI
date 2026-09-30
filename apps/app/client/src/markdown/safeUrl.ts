/**
 * The link allow-list for model-written Markdown: `http:`/`https:` and relative URLs only.
 * Anything else (`javascript:`, `data:`, `vbscript:`, `file:`, `mailto:`…) returns null and the
 * link renders as plain text. Browsers ignore tabs, newlines and leading control characters in a
 * scheme, so those are stripped before the scheme is read.
 */
export function safeUrl(url: string): string | null {
  const probe = url.replace(/[\u0000- \u007f]/g, '');
  if (probe === '') return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(probe);
  if (!scheme) return url.trim();
  const name = scheme[1]?.toLowerCase();
  return name === 'http' || name === 'https' ? url.trim() : null;
}
