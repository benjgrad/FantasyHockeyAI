/**
 * Pull Yahoo's `T` and `Y` session cookies out of whatever the user pasted.
 *
 * `T` is HttpOnly, so no console script or bookmarklet can read it: page JavaScript is walled
 * off from it by design. What *does* carry it is DevTools' "Copy as cURL" on any Yahoo request,
 * whose cookie header lists every cookie. So the settings page takes one paste of that (or of a
 * raw `Cookie:` header, or `T=…; Y=…`), and this picks out the two values **in the browser**.
 * Nothing else from the paste — the other cookies, the URL, the headers — is ever sent to the
 * server.
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
