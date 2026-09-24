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

function playerCard(p, isRec) {
  const cats = [...p.best, ...p.worst]
    .map((c) => `<div class="n">${esc(c.cat)} <b>${sign(c.z)}</b>${zBar(c.z)}</div>`)
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

  if (s.pendingOverride) {
    parts.push(`<div class="card warn">Override queued: <b>${esc(s.pendingOverride.name)}</b>
      <div class="pillrow"><button id="clear">Cancel override</button></div></div>`);
  }

  if (s.recommendation) {
    parts.push(
      `<div class="card"><div class="tag">recommended pick</div>${playerCard(s.recommendation, true)}</div>`,
    );
  } else {
    parts.push(`<div class="card warn">No recommendation available.</div>`);
  }

  if (s.alternates.length) {
    parts.push(
      `<div class="card"><div class="tag">alternatives</div>${s.alternates
        .map(
          (a) => `<div class="alt">
          <div><b>${esc(a.name)}</b> <span class="muted">${esc(a.position)} · ${esc(a.team)} · vorp ${a.vorp.toFixed(2)} · fit ${sign(a.fit)}${a.lowConfidence ? ' · <span class="thin">thin</span>' : ''}</span>
            <div class="muted">${esc(a.reasons[0] ?? '')}</div></div>
          <button data-id="${a.nhlId}">Pick</button>
        </div>`,
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

  $('app').innerHTML = parts.join('');

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

async function tick() {
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    render(await res.json());
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
