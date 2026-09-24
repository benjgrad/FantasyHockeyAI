// Reads the current pre-draft ranking page: whether a custom list exists, and its order.
() => {
  const text = document.body.innerText;
  const idx = text.search(/Your Rankings/i);
  const def = text.search(/Default Rankings/i);
  const slice = (a, b) => text.slice(a, b < 0 ? a + 600 : b).replace(/\s+/g, ' ').trim();
  return {
    hasCustom: idx >= 0,
    yourRankings: idx >= 0 ? slice(idx, def) : null,
    defaultStart: def >= 0 ? slice(def, def + 320) : null,
  };
}
