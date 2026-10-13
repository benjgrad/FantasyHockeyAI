/**
 * Pull Yahoo's `T` and `Y` session cookies out of whatever the user pasted.
 *
 * `T` is HttpOnly, so no console script or bookmarklet can read it: page JavaScript is walled
 * off from it by design. What *does* carry it is DevTools' "Copy as cURL" on any Yahoo request,
 * whose cookie header lists every cookie. So the settings page takes one paste of that (or of a
 * raw `Cookie:` header, or `T=…; Y=…`), and this picks the cookies out **in the browser**. T and
 * Y are required; the other cookies go too (D-033: A1, A3 and A1S keep the website signed in).
 * Nothing else from the paste — the URL, the headers — is ever sent to the server.
 *
 * Handles the copy formats browsers produce: bash cURL (`-b '…'` or `-H 'cookie: …'`), Windows
 * cmd cURL (`^`-escaped), PowerShell (`New-Object System.Net.Cookie("T", "…"`), "Copy as fetch"
 * JSON headers, and plain cookie strings.
 */
export interface YahooCookies {
  T?: string;
  Y?: string;
}

/** Undo Windows cmd escaping (`^"`, `^%`, `^&`, …) so the cookie text reads as it would in bash. */
function unCmd(text: string): string {
  return text.includes('^') ? text.replace(/\^(.)/g, '$1') : text;
}

/** A cookie value runs to the next `;`, quote, whitespace or backslash (JSON/shell escaping). */
function cookieFrom(text: string, name: 'T' | 'Y'): string | undefined {
  // Preceded by start, `;`, whitespace, a quote or `=` after "cookie": never part of a longer
  // name such as AT= or OTH= or AWSALBTG=.
  const re = new RegExp(`(?:^|[;\\s'"])${name}=([^;'"\\s\\\\]+)`);
  return re.exec(text)?.[1];
}

function fromPowerShell(text: string, name: 'T' | 'Y'): string | undefined {
  const re = new RegExp(`System\\.Net\\.Cookie\\(\\s*"${name}"\\s*,\\s*"([^"]+)"`);
  return re.exec(text)?.[1];
}

export function extractYahooCookies(pasted: string): YahooCookies {
  const text = unCmd(pasted.trim());
  const out: YahooCookies = {};
  for (const name of ['T', 'Y'] as const) {
    const v = fromPowerShell(text, name) ?? cookieFrom(text, name);
    if (v !== undefined && v.length >= 10) out[name] = v;
  }
  return out;
}

const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
/** As the server's contract allows: a bounded number of cookies, each of bounded size. */
const MAX_COOKIES = 60;
const MAX_VALUE = 4096;

/** The cookie header inside a cURL (`-b`, `-H 'cookie: …'`), a fetch copy, or a bare string. */
function cookieHeader(text: string): string {
  const b = /(?:^|\s)(?:-b|--cookie)\s+(['"])([\s\S]*?)\1/.exec(text);
  if (b?.[2] !== undefined) return b[2];
  const h = /['"]cookie:\s*([^'"]*)['"]/i.exec(text);
  if (h?.[1] !== undefined) return h[1];
  const json = /"cookie"\s*:\s*"([^"]*)"/i.exec(text);
  if (json?.[1] !== undefined) return json[1];
  return /^curl\b/i.test(text) ? '' : text.replace(/\n/g, ';');
}

/**
 * Every cookie in the paste other than T and Y, by name (D-033). Malformed pairs are skipped;
 * the server checks the same bounds.
 */
export function extractOtherCookies(pasted: string): Record<string, string> {
  const text = unCmd(pasted.trim());
  const out: Record<string, string> = {};
  const add = (name: string, value: string) => {
    if (name === 'T' || name === 'Y' || !NAME.test(name)) return;
    if (value === '' || value.length > MAX_VALUE || /\s/.test(value)) return;
    if (Object.keys(out).length < MAX_COOKIES) out[name] = value;
  };
  const ps = [...text.matchAll(/System\.Net\.Cookie\(\s*"([^"]+)"\s*,\s*"([^"]*)"/g)];
  if (ps.length > 0) {
    for (const m of ps) add(m[1] ?? '', m[2] ?? '');
    return out;
  }
  for (const pair of cookieHeader(text).split(';')) {
    const eq = pair.indexOf('=');
    if (eq > 0) add(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return out;
}
