// Draft board front end. Polls /api/state; the server is the only source of truth.
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );
const sign = (n) => (n >= 0 ? '+' + n.toFixed(2) : n.toFixed(2));

function zBar(z) {
  // -3..+3 mapped to a bar; colour by direction so a weakness reads as a weakness.
  const pct = Math.max(0, Math.min(100, ((z + 3) / 6) * 100));
  const col = z >= 0.5 ? 'var(--good)' : z <= -0.5 ? 'var(--bad)' : 'var(--mut)';
  return `<div class="bar"><i style="width:${pct}%;background:${col}"></i></div>`;
}

let LOWER = [];

/** Does a positive delta in this category help us? GAA and GA are inverted. */
const better = (cat, d) => (LOWER.includes(cat) ? -d : d);

function fmt(cat, n) {
  if (cat === 'SV%') return n.toFixed(3).replace(/^0/, '');
  if (cat === 'GAA') return n.toFixed(2);
  return Math.round(n).toString();
}

/**
 * A goalie and a skater are scored in different categories, so differencing them is noise:
 * it renders as "-324 SOG" against a goalie who never takes a shot. Across position types we
 * show the player's own numbers instead, and say why.
 */
const comparable = (alt, rec) => Boolean(rec) && alt.positionType === rec.positionType;

function ownSummary(alt) {
  return alt.cats
    .slice(0, 4)
    .map((c) => {
      const t = alt.stats.find((x) => x.cat === c.cat);
      return `<span class="d own">${fmt(c.cat, t ? t.total : 0)} ${esc(c.cat)}</span>`;
    })
    .join('');
}

function deltaSummary(alt, rec) {
  if (!rec) return '';
  if (!comparable(alt, rec)) return ownSummary(alt);
  const rs = new Map(rec.stats.map((x) => [x.cat, x.total]));
  const deltas = alt.stats
    .map((x) => ({ cat: x.cat, d: x.total - (rs.get(x.cat) ?? 0) }))
    .filter((x) => Math.abs(x.d) > 0.0005)
    .sort((a, b) => better(b.cat, b.d) - better(a.cat, a.d));
  const up = deltas.filter((x) => better(x.cat, x.d) > 0).slice(0, 3);
  const down = deltas.filter((x) => better(x.cat, x.d) < 0).slice(-2);
  const chip = (x, cls) =>
    `<span class="d ${cls}">${x.d > 0 ? '+' : ''}${fmt(x.cat, x.d)} ${esc(x.cat)}</span>`;
  return up.map((x) => chip(x, 'up')).join('') + down.map((x) => chip(x, 'down')).join('');
}

function ownTable(alt, rec) {
  const rows = alt.stats
    .filter((x) => Math.abs(x.total) > 0.0005)
    .map((x) => {
      const z = alt.cats.find((c) => c.cat === x.cat);
      return `<tr><td>${esc(x.cat)}</td><td>${fmt(x.cat, x.total)}</td><td class="muted" colspan="2">${sign(z ? z.z : 0)}z</td><td></td></tr>`;
    })
    .join('');
  const kinds = `${alt.positionType === 'G' ? 'goalie' : 'skater'} vs ${rec.positionType === 'G' ? 'goalie' : 'skater'}`;
  return `<div class="muted" style="margin-bottom:4px">Different categories (${esc(kinds)}) — showing his own numbers, not a difference.</div>
    <table class="cmp"><tr><th>cat</th><th>${esc(alt.name.split(' ').pop())}</th><th colspan="2">z</th><th></th></tr>${rows}</table>`;
}

function deltaTable(alt, rec) {
  if (!comparable(alt, rec)) return ownTable(alt, rec);
  const rs = new Map(rec.stats.map((x) => [x.cat, x.total]));
  const zs = new Map(rec.cats.map((x) => [x.cat, x.z]));
  const rows = alt.stats
    .map((x) => {
      const r = rs.get(x.cat) ?? 0;
      const d = x.total - r;
      const good = better(x.cat, d);
      const cls = Math.abs(d) < 0.0005 ? '' : good > 0 ? 'up' : 'down';
      const az = alt.cats.find((c) => c.cat === x.cat)?.z ?? 0;
      const rz = zs.get(x.cat) ?? 0;
      return `<tr>
        <td>${esc(x.cat)}</td>
        <td>${fmt(x.cat, x.total)}</td>
        <td class="muted">${fmt(x.cat, r)}</td>
        <td class="${cls}">${d > 0 ? '+' : ''}${fmt(x.cat, d)}</td>
        <td class="muted">${sign(az - rz)}z</td>
      </tr>`;
    })
    .join('');
  // The scoring terms, diffed too: they are what actually ordered the board, so a comparison
  // that stops at the categories hides why one player outranks another.
  // adp is deliberately uncoloured — the market taking someone earlier is neither good nor bad
  // for us, it is just information.
  const metrics = [
    { k: 'score', a: alt.score, r: rec.score, dp: 2, dir: 1 },
    { k: 'vorp', a: alt.vorp, r: rec.vorp, dp: 2, dir: 1 },
    { k: 'fit', a: alt.fit, r: rec.fit, dp: 2, dir: 1 },
    { k: 'need', a: alt.need, r: rec.need, dp: 2, dir: 1 },
    { k: 'urgency', a: alt.urgency, r: rec.urgency, dp: 2, dir: 1 },
    { k: 'proj gp', a: alt.gp, r: rec.gp, dp: 0, dir: 1 },
    { k: 'adp', a: alt.adp ?? null, r: rec.adp ?? null, dp: 1, dir: 0 },
  ];
  const mrows = metrics
    .filter((m) => m.a !== null && m.r !== null)
    .map((m) => {
      const d = m.a - m.r;
      const cls = m.dir === 0 || Math.abs(d) < 0.005 ? '' : d * m.dir > 0 ? 'up' : 'down';
      return `<tr>
        <td>${esc(m.k)}</td>
        <td>${m.a.toFixed(m.dp)}</td>
        <td class="muted">${m.r.toFixed(m.dp)}</td>
        <td class="${cls}">${d > 0 ? '+' : ''}${d.toFixed(m.dp)}</td>
        <td></td>
      </tr>`;
    })
    .join('');

  return `<table class="cmp">
    <tr><th>cat</th><th>${esc(alt.name.split(' ').pop())}</th><th>${esc(rec.name.split(' ').pop())}</th><th>Δ</th><th>Δz</th></tr>
    ${rows}
    <tr class="sep"><td colspan="5"></td></tr>
    ${mrows}</table>`;
}

function playerCard(p, isRec) {
  const top = [...p.cats.slice(0, 4), ...p.cats.slice(-2)];
  const statByCat = new Map(p.stats.map((x) => [x.cat, x.total]));
  const cats = top
    .map(
      (c) =>
        `<div class="n">${esc(c.cat)} <b>${fmt(c.cat, statByCat.get(c.cat) ?? 0)}</b> <span class="muted">${sign(c.z)}z</span>${zBar(c.z)}</div>`,
    )
    .join('');
  const allStats = p.stats
    .map((x) => `<div class="n">${esc(x.cat)} <b>${fmt(x.cat, x.total)}</b></div>`)
    .join('');
  return `
    <div class="row">
      <div><span class="big">${esc(p.name)}</span>
        <span class="tag"> ${esc(p.position)} · ${esc(p.team)}${p.lowConfidence ? ' · <span class="thin">thin data</span>' : ''}</span>
      </div>
    </div>
    <div class="nums">
      <div class="n">score <b>${p.score.toFixed(2)}</b></div>
      <div class="n">vorp <b>${p.vorp.toFixed(2)}</b></div>
      <div class="n">fit <b>${sign(p.fit)}</b></div>
      <div class="n">need <b>${p.need.toFixed(2)}x</b></div>
      ${p.urgency !== 0 ? `<div class="n">urgency <b>${sign(p.urgency)}</b></div>` : ''}
      ${p.adp ? `<div class="n">adp <b>${p.adp.toFixed(0)}</b></div>` : ''}
      <div class="n">gp <b>${p.gp}</b></div>
    </div>
    <div class="nums">${cats}</div>
    ${p.reasons.length ? `<ul class="why">${p.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    <details data-key="cats-${p.nhlId}"><summary class="tag">all 13 projected categories</summary><div class="nums">${allStats}</div></details>
    ${isRec ? `<button class="pick" data-id="${p.nhlId}">Lock in ${esc(p.name)}</button>` : ''}`;
}

function render(s) {
  $('sub').textContent =
    `${s.draftStatus} · pick ${s.picksMade + 1} of ${s.totalPicks} · seat ${s.ourSeat ?? '?'}` +
    (s.nextOurPick ? ` · our next: ${s.nextOurPick}` : '') +
    ` · updated ${new Date(s.now).toLocaleTimeString()}`;

  const parts = [];
  for (const w of s.warnings) parts.push(`<div class="card warn">${esc(w)}</div>`);

  if (s.onClock) {
    parts.push(`<div class="card clock ${s.onClock.isOurs ? 'ours' : ''}">
      <div class="row"><span class="tag">${s.onClock.isOurs ? 'WE ARE ON THE CLOCK' : 'on the clock'}</span>
      <span class="muted">pick ${s.onClock.pick} · team ${esc(s.onClock.teamId)} · ${s.onClock.secs}s</span></div>
    </div>`);
  }

  if (s.recommendation) {
    parts.push(
      (() => {
        // An override is the current pick, so it leads — but the model's choice stays visible
        // and one tap away, otherwise overriding is a decision you cannot walk back.
        const isOv = s.recommendation.isOverride === true;
        const head = isOv
          ? `<div class="tag ovtag">your pick (override)</div>` +
            (s.modelPick
              ? `<div class="muted" style="margin-bottom:6px">model wanted <b>${esc(s.modelPick.name)}</b> · <button id="clear" class="linkish">revert to it</button></div>`
              : '')
          : `<div class="tag">recommended pick</div>`;
        return `<div class="card ${isOv ? 'ovcard' : ''}">${head}${playerCard(s.recommendation, true)}</div>`;
      })(),
    );
  } else {
    parts.push(`<div class="card warn">No recommendation available.</div>`);
  }

  const rec = s.recommendation;
  if (s.alternates.length) {
    parts.push(
      `<div class="card"><div class="tag">alternatives — difference from ${esc(rec ? rec.name : 'the pick')}</div>${s.alternates
        .map(
          (a) => `<details class="alt" data-key="alt-${a.nhlId}">
          <summary>
            <div><b>${esc(a.name)}</b> <span class="muted">${esc(a.position)} · ${esc(a.team)} · score ${a.score.toFixed(2)}${a.lowConfidence ? ' · <span class="thin">thin</span>' : ''}</span>
              <div class="chips">${deltaSummary(a, rec)}</div></div>
          </summary>
          <div class="altbody">
            ${rec ? deltaTable(a, rec) : ''}
            ${a.reasons.length ? `<ul class="why">${a.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
            <button data-id="${a.nhlId}">Pick ${esc(a.name)}</button>
          </div>
        </details>`,
        )
        .join('')}</div>`,
    );
  }

  parts.push(`<div class="card"><div class="tag">our roster (${s.roster.length})</div>
    <div class="muted" style="margin:4px 0 8px">open starting slots: ${s.openSlots.length ? esc(s.openSlots.join(', ')) : 'none'}</div>
    <table>${s.roster.map((r) => `<tr><td>${esc(r.name)} <span class="muted">${esc(r.position)}</span></td><td>${r.vorp.toFixed(2)}</td></tr>`).join('') || '<tr><td class="muted">nobody yet</td><td></td></tr>'}</table></div>`);

  parts.push(`<div class="card"><div class="tag">category strength (weakest first)</div>
    <table>${s.categoryStrength.map((c) => `<tr><td>${esc(c.cat)}</td><td>${sign(c.z)}</td></tr>`).join('')}</table></div>`);

  parts.push(`<div class="card"><div class="tag">recent picks</div>
    <table>${s.recentPicks.map((p) => `<tr><td class="${p.mine ? 'mine' : ''}">${p.pick}. ${esc(p.name)} <span class="muted">${esc(p.position)}</span>${p.mine ? ' ←' : ''}</td><td></td></tr>`).join('') || '<tr><td class="muted">none yet</td><td></td></tr>'}</table></div>`);

  /*
   * The board re-renders every few seconds, and innerHTML throws away DOM state: an expanded
   * alternative collapsed itself a moment after being opened, and the page jumped to the top.
   * Open <details> are keyed by player, so they can be restored after the swap.
   */
  const open = new Set(
    [...document.querySelectorAll('details[data-key]')]
      .filter((d) => d.open)
      .map((d) => d.dataset.key),
  );
  const scroll = window.scrollY;

  $('app').innerHTML = parts.join('');

  for (const d of document.querySelectorAll('details[data-key]')) {
    if (open.has(d.dataset.key)) d.open = true;
  }
  if (Math.abs(window.scrollY - scroll) > 1) window.scrollTo(0, scroll);

  for (const b of document.querySelectorAll('[data-id]')) {
    b.addEventListener('click', async () => {
      b.disabled = true;
      b.textContent = 'setting…';
      const res = await fetch('/api/prefer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nhlId: Number(b.dataset.id) }),
      });
      if (!res.ok) b.textContent = 'failed';
      tick();
    });
  }
  const clear = $('clear');
  if (clear)
    clear.addEventListener('click', async () => {
      await fetch('/api/prefer', { method: 'DELETE' });
      tick();
    });
}

let lastPayload = '';

async function tick() {
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    const text = await res.text();
    const data = JSON.parse(text);
    LOWER = data.lowerIsBetter || [];
    // `now` changes every poll, so compare everything else: an unchanged board must not
    // re-render at all.
    const { now, ...rest } = data;
    const key = JSON.stringify(rest);
    $('sub').textContent =
      `${data.draftStatus} · pick ${data.picksMade + 1} of ${data.totalPicks} · seat ${data.ourSeat ?? '?'}` +
      (data.nextOurPick ? ` · our next: ${data.nextOurPick}` : '') +
      ` · updated ${new Date(now).toLocaleTimeString()}`;
    if (key === lastPayload) return;
    lastPayload = key;
    render(data);
  } catch {
    $('sub').textContent = 'connection lost — retrying…';
  }
}
tick();
setInterval(tick, 3000);

// ---- push ----
const b64 = (s) => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
};

async function initPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    $('pushstate').textContent = 'unsupported on this browser';
    return null;
  }
  const reg = await navigator.serviceWorker.register('/sw.js');
  const sub = await reg.pushManager.getSubscription();
  $('pushstate').textContent = sub ? 'enabled' : 'not enabled';
  return reg;
}
let regPromise = initPush();

$('enable').addEventListener('click', async () => {
  const reg = await regPromise;
  if (!reg) return;
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    $('pushstate').textContent = `permission ${perm}`;
    return;
  }
  const { publicKey } = await (await fetch('/api/vapid')).json();
  if (!publicKey) {
    $('pushstate').textContent = 'server has no VAPID keys';
    return;
  }
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: b64(publicKey),
  });
  await fetch('/api/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sub),
  });
  $('pushstate').textContent = 'enabled';
});

$('test').addEventListener('click', async () => {
  const r = await fetch('/api/test-push', { method: 'POST' });
  const j = await r.json().catch(() => ({}));
  $('pushstate').textContent = r.ok
    ? `test sent to ${j.sent}`
    : `test failed: ${j.error ?? r.status}`;
});
