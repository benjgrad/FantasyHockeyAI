// MCP step 6b: open the pre-rank "Import" dialog (does NOT import or save anything).
// The dialog is a portal without role=dialog; take a screenshot to read it.
async () => {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Import');
  if (!btn) return { opened: false };
  btn.click();
  await new Promise((r) => setTimeout(r, 1500));
  const text = document.body.innerText;
  const i = text.indexOf('Import Rankings');
  return { opened: i >= 0, dialogText: i >= 0 ? text.slice(i, i + 900) : null };
}
