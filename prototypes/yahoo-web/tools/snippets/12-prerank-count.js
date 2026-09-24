// Counts the saved custom pre-draft ranking precisely, from the DOM rather than innerText.
() => {
  const text = document.body.innerText;
  const y = text.search(/Your Rankings/i);
  const d = text.search(/Default Rankings/i);
  const span = y >= 0 ? text.slice(y, d > y ? d : undefined) : '';
  const nums = [...span.matchAll(/(^|\n)\s*(\d{1,3})\.\s+(\S[^\n]*)/g)].map(m => [Number(m[2]), m[3].trim()]);
  return {
    highestNumber: nums.length ? Math.max(...nums.map(n => n[0])) : 0,
    entriesParsed: nums.length,
    first5: nums.slice(0, 5),
    last5: nums.slice(-5),
    pageHasPagination: /next|more|show all/i.test(text.slice(0, 4000)),
  };
}
