// MCP step 7: what the draft page shows (pre-draft overview vs live room).
// Run on: https://hockey.fantasysports.yahoo.com/hockey/{leagueId}/draft
async () => {
  await new Promise((r) => setTimeout(r, 4000));
  return { url: location.href, title: document.title, text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 1200) };
}
