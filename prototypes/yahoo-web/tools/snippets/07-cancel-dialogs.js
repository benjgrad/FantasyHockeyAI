// MCP step 6c: close any open dialog via its visible Cancel button(s). Never clicks Save/Import.
() => { const b = Array.from(document.querySelectorAll('button')).filter((x) => x.textContent.trim() === 'Cancel' && x.offsetParent); b.forEach((x) => x.click()); return { cancelled: b.length }; }
