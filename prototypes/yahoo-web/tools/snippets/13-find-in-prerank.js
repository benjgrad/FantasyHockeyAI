// Finds a named player in the saved pre-draft ranking, and reports the list length.
() => {
  const want = (window.__FHA && window.__FHA.name) || 'Gavin McKenna';
  const text = document.body.innerText;
  const y = text.search(/Your Rankings/i);
  const d = text.search(/Default Rankings/i);
  const span = y >= 0 ? text.slice(y, d > y ? d : undefined) : '';
  const entries = [...span.matchAll(/(^|\n)\s*(\d{1,3})\.\s+([^\n]+)/g)].map(m => [Number(m[2]), m[3].trim()]);
  const hit = entries.find(e => e[1].toLowerCase().includes(want.toLowerCase()));
  const around = hit ? entries.filter(e => Math.abs(e[0] - hit[0]) <= 3) : [];
  return {
    listLength: entries.length,
    highestNumber: entries.length ? Math.max(...entries.map(e => e[0])) : 0,
    found: Boolean(hit),
    at: hit ? hit[0] : null,
    neighbours: around,
  };
}
