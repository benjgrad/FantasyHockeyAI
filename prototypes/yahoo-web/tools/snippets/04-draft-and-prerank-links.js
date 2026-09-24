// MCP: find draft room, mock lobby and pre-rank URLs from a league page.
() => [...new Set(Array.from(document.querySelectorAll('a[href]')).map((a) => a.href).filter((h) => /draft|prerank|mock/i.test(h)))]
