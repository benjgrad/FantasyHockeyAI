// MCP step 1-2: is the page signed in, and which league links does it show?
// Run on: https://hockey.fantasysports.yahoo.com/hockey
() => ({
  url: location.href,
  title: document.title,
  signedOut: !!Array.from(document.querySelectorAll('a')).find((a) => /^\s*sign in\s*$/i.test(a.textContent)),
  leagueLinks: [...new Set(Array.from(document.querySelectorAll('a[href]')).map((a) => a.href)
    .filter((h) => /hockey\.fantasysports\.yahoo\.com\/hockey\/\d+/.test(h)))].slice(0, 25),
})
