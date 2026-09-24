// MCP step 6: inspect the pre-rank EDITOR without changing it.
// Run on: https://hockey.fantasysports.yahoo.com/hockey/{leagueId}/{teamId}/editprerank
() => ({
  url: location.href,
  forms: Array.from(document.forms).filter((f) => f.id !== 'ybar-sf').map((f) => ({ action: f.action, method: f.method, id: f.id, inputCount: f.elements.length })),
  buttons: Array.from(document.querySelectorAll('button, input[type=submit]')).map((b) => (b.textContent || b.value || '').trim()).filter(Boolean).slice(0, 40),
  sections: Array.from(document.querySelectorAll('[id]')).filter((e) => /player|rank|list/i.test(e.id)).map((e) => ({ tag: e.tagName, id: e.id, children: e.children.length })),
})
