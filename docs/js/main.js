/**
 * main.js — application shell: boot, theming, routing, and the views the
 * shell owns (home, modules, browse, settings). Quiz and analytics are
 * mounted from their own modules through the documented interface.
 */
import { loadData, getData, enabledQuestions, taxonomies, taxonomyById,
         moduleById, sourceLabel } from './data.js';
import * as store from './store.js';
import * as srs from './srs.js';
import { route, setNotFound, start, navigate, bus } from './router.js';
import { el, mount, clear, toast, humanDays, relTime, plural, confirmDialog } from './ui.js';

const view = document.getElementById('view');
const deps = { store, srs, data: { getData, enabledQuestions, moduleById, sourceLabel }, bus };

/* ------------------------------------------------------------- theming */
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  store.setSetting('theme', t);
}
document.getElementById('themeBtn').addEventListener('click', () => {
  const order = ['auto', 'light', 'dark'];
  const cur = store.getSettings().theme || 'auto';
  const next = order[(order.indexOf(cur) + 1) % order.length];
  applyTheme(next);
  toast(`Theme: ${next}`);
});

/* ------------------------------------------------------- shared pieces */
function queueSummary() {
  const settings = store.effectiveSettings();
  const qs = enabledQuestions(settings);
  // 6th arg is the review log: without it summarize() returns retention: null
  return srs.summarize(qs, store.allCards(), settings, store.todayCounts(),
                       new Date(), store.getLog());
}

function statTile(k, v, s, accent) {
  return el('.stat', {}, [
    el('.k', { text: k }),
    el('.v', { text: String(v), style: accent ? { color: accent } : {} }),
    s ? el('.s', { text: s }) : null,
  ]);
}

/* ------------------------------------------------------------ home view */
function renderHome() {
  const settings = store.getSettings();
  const d = getData();
  const enabled = settings.enabledModules || [];

  if (!enabled.length) {
    return mount(view,
      el('.page-head', {}, [
        el('h1', { text: 'Start by choosing what to learn' }),
        el('p', { text: `This deck is built from the ${d.version} Patient Care Guidelines — ${d.counts.questions.toLocaleString()} questions across ${d.counts.modules} modules. Turn on a module or two to begin; you can add more at any time, and only what you enable gets scheduled.` }),
      ]),
      el('.grid.grid-auto', {}, taxonomies().slice(0, 3).map((t) => el('.card', {}, [
        el('h3', { text: t.label }),
        el('p', { text: t.description, style: { color: 'var(--text-2)', fontSize: 'var(--fs-sm)' } }),
        el('button.btn.btn-primary', { text: 'Browse modules',
          onclick: () => navigate(`/modules?tax=${t.id}`) }),
      ]))),
    );
  }

  const s = queueSummary();
  const pctDone = s.total ? s.seen / s.total : 0;
  const base = store.getSettings();
  const eff = store.effectiveSettings();
  const today = store.todayCounts();
  // "No new cards" has two very different causes: the deck is exhausted, or
  // today's intake cap is spent. Saying which one it is turns a dead end into
  // a choice.
  const untouched = s.total - s.seen;
  const capped = s.newAvail === 0 && untouched > 0 && today.new >= eff.dailyNew;

  mount(view,
    el('.page-head', {}, [
      el('h1', { text: s.due + s.newAvail > 0 ? 'Ready when you are' : 'All caught up' }),
      el('p', { text: s.due + s.newAvail > 0
        ? `${plural(s.due, 'card')} due and ${plural(s.newAvail, 'new card')} available in your ${plural(enabled.length, 'enabled module')}.`
        : `Nothing is due right now. Your next review is ${relTime(s.nextDue)}. Enable another module to keep going.` }),
    ]),
    el('.grid.grid-stats', { style: { marginBottom: 'var(--sp-6)' } }, [
      statTile('Due now', s.due, 'scheduled reviews', s.due ? 'var(--accent)' : null),
      statTile('New available', s.newAvail,
        capped ? `daily limit of ${base.dailyNew} reached` : `limit ${eff.dailyNew}/day`,
        capped ? 'var(--warn)' : null),
      statTile('Learned', s.seen, `of ${s.total} in scope`),
      statTile('Retention', s.retention === null ? '—' : `${Math.round(s.retention * 100)}%`,
        'last 30 days', s.retention !== null && s.retention < 0.8 ? 'var(--warn)' : 'var(--ok)'),
    ]),
    el('.card', { style: { marginBottom: 'var(--sp-6)' } }, [
      el('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 'var(--sp-4)', marginBottom: 'var(--sp-3)' } }, [
        el('strong', { text: 'Coverage of enabled modules' }),
        el('span', { text: `${Math.round(pctDone * 100)}%`, style: { color: 'var(--text-2)' } }),
      ]),
      el('.meter', {}, [el('i', { style: { width: `${pctDone * 100}%` } })]),
      el('p', { style: { margin: 'var(--sp-3) 0 0', color: 'var(--text-3)', fontSize: 'var(--fs-sm)' },
        text: `${s.seen} seen · ${s.young} still settling · ${s.mature} mature · ${s.total - s.seen} untouched` }),
    ]),
    capped ? el('.card.cap-note', { style: { marginBottom: 'var(--sp-5)' } }, [
      el('strong', { text: `Today's new-card limit is used up (${today.new} of ${eff.dailyNew}).` }),
      el('p', { style: { margin: 'var(--sp-2) 0 var(--sp-4)', color: 'var(--text-2)' },
        text: `${untouched.toLocaleString()} cards in your enabled modules have not been introduced yet. The limit paces how fast new material enters rotation so reviews stay manageable later — but you can take more today, or change the pace for good in Settings.` }),
      el('div', { style: { display: 'flex', gap: 'var(--sp-3)', flexWrap: 'wrap' } }, [
        el('button.btn.btn-primary', { text: 'Add 20 more new cards today',
          onclick: () => { store.grantExtraNew(20); toast('20 more new cards unlocked for today'); renderHome(); } }),
        el('a.btn', { href: '#/settings', text: 'Change the daily pace' }),
      ]),
    ]) : null,

    el('div', { style: { display: 'flex', gap: 'var(--sp-3)', flexWrap: 'wrap' } }, [
      el('button.btn.btn-primary', {
        text: s.due + s.newAvail > 0 ? `Study ${Math.min(s.due + s.newAvail, store.getSettings().dailyMax)} cards` : 'Study anyway (ahead of schedule)',
        onclick: () => navigate('/study'),
      }),
      el('a.btn', { href: '#/modules', text: 'Manage modules' }),
      el('a.btn', { href: '#/stats', text: 'Analytics' }),
    ]),
  );
}

/* --------------------------------------------------------- modules view */
function renderModules({ params }) {
  const settings = store.getSettings();
  const taxId = params.tax || settings.taxonomy || 'section';
  const tax = taxonomyById(taxId);
  const enabled = new Set(settings.enabledModules);
  const cards = store.allCards();

  const groups = new Map();
  for (const m of tax.modules) {
    const g = m.group || m.label;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(m);
  }

  const header = el('.page-head', {}, [
    el('h1', { text: 'Modules' }),
    el('p', { text: tax.description }),
    el('.seg', { style: { marginTop: 'var(--sp-4)' }, role: 'tablist' },
      taxonomies().map((t) => el('button', {
        text: t.label, 'aria-pressed': String(t.id === taxId),
        onclick: () => { store.setSetting('taxonomy', t.id); navigate(`/modules?tax=${t.id}`); },
      }))),
  ]);

  const sections = [...groups.entries()].map(([gname, mods]) => {
    const allOn = mods.every((m) => enabled.has(m.id));
    return el('section', { style: { marginBottom: 'var(--sp-8)' } }, [
      el('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', marginBottom: 'var(--sp-3)' } }, [
        el('h2', { text: gname, style: { margin: 0, fontSize: 'var(--fs-lg)' } }),
        el('span.chip', { text: `${mods.reduce((a, m) => a + m.question_count, 0)} questions` }),
        el('span', { style: { flex: 1 } }),
        el('button.btn.btn-sm', {
          text: allOn ? 'Disable all' : 'Enable all',
          onclick: () => { mods.forEach((m) => store.toggleModule(m.id, !allOn)); renderModules({ params }); },
        }),
      ]),
      el('.grid.grid-auto', {}, mods.map((m) => moduleCard(m, enabled, cards, params))),
    ]);
  });

  mount(view, header, ...sections);
}

function moduleCard(m, enabled, cards, params) {
  const on = enabled.has(m.id);
  const seen = m.question_ids.filter((id) => cards[id]).length;
  const prog = m.question_count ? seen / m.question_count : 0;
  const locked = (m.prereq || []).filter((p) => {
    const pm = moduleById(p);
    if (!pm) return false;
    const pseen = pm.question_ids.filter((id) => cards[id]).length;
    return pseen / Math.max(pm.question_count, 1) < 0.5;   // advisory only
  });

  return el('button.modcard', {
    type: 'button',
    'aria-pressed': String(on),
    dataset: { on: String(on) },
    onclick: () => { store.toggleModule(m.id); renderModules({ params }); },
  }, [
    el('.modcard-top', {}, [
      el('strong', { text: m.label }),
      el('span.modcard-tick', { html: on
        ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
        : '' }),
    ]),
    el('.modcard-sub', { text: m.subtitle || `${m.question_count} questions` }),
    el('.meter', { style: { marginTop: 'var(--sp-3)' } }, [el('i', { style: { width: `${prog * 100}%` } })]),
    el('.modcard-foot', {}, [
      el('span', { text: `${seen}/${m.question_count} seen` }),
      locked.length ? el('span.chip', { text: 'builds on earlier part' }) : null,
    ]),
  ]);
}

/* ---------------------------------------------------------- browse view */
function renderBrowse({ params }) {
  const d = getData();
  const q = (params.q || '').toLowerCase();

  const items = [
    ...d.content.guidelines.map((g) => ({
      kind: 'guideline', id: g.id, number: g.number, title: g.title,
      sub: `${g.section_title} · p.${g.page}`, levels: g.care_levels, rec: g,
      search: `${g.number} ${g.title} ${g.section_title}`.toLowerCase(),
    })),
    ...d.content.drugs.map((x) => ({
      kind: 'drug', id: x.id, number: x.number, title: x.name,
      sub: `Formulary · p.${x.page}`, levels: [], rec: x,
      search: `${x.number} ${x.name} ${(x.info['Trade Name'] || '')} ${(x.info['Pharmacologic Category'] || '')}`.toLowerCase(),
    })),
  ].filter((i) => !q || i.title.toLowerCase().includes(q) || i.number.includes(q));

  // The result list is re-filtered in place rather than by re-routing. Routing
  // on each keystroke re-rendered the whole view, which destroyed and replaced
  // the input element — so focus was lost and only one character landed before
  // the field had to be clicked again.
  const listEl = el('.browse-list');
  const moreEl = el('p', { style: { color: 'var(--text-3)' } });

  const matches = (i, q) => !q
    || i.title.toLowerCase().includes(q)
    || i.number.includes(q)
    || (i.search || '').includes(q);

  function paint(q) {
    const hits = items.filter((i) => matches(i, q));
    clear(listEl);
    if (!hits.length) {
      listEl.append(el('.empty', { style: { padding: 'var(--sp-8)' } }, [
        el('h3', { text: 'No matches' }),
        el('p', { text: `Nothing matches “${q}”. Try a guideline number, a drug name, or a keyword.` }),
      ]));
    } else {
      for (const i of hits.slice(0, 400)) {
        listEl.append(el('a.browse-row', { href: `#/item/${i.id}` }, [
          el('span.browse-num', { text: i.number }),
          el('span.browse-title', { text: i.title }),
          el('span.browse-sub', { text: i.sub }),
          el('span', {}, i.levels.map((l) => el(`span.chip.chip-${l.toLowerCase()}`, { text: l }))),
        ]));
      }
    }
    moreEl.textContent = hits.length > 400
      ? `Showing first 400 of ${hits.length}. Narrow the search to see more.` : '';
    // Keep the URL shareable without re-rendering: replaceState does not fire
    // hashchange, so the router stays put and the input keeps focus.
    const want = q ? `#/browse?q=${encodeURIComponent(q)}` : '#/browse';
    if (location.hash !== want) history.replaceState(null, '', want);
  }

  const input = el('input.search', {
    type: 'search', placeholder: 'Search guidelines, drugs, keywords…',
    value: params.q || '', 'aria-label': 'Search content',
    autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false',
    oninput: (e) => paint(e.target.value.trim().toLowerCase()),
  });

  mount(view,
    el('.page-head', {}, [
      el('h1', { text: 'Browse the guidelines' }),
      el('p', { text: `All ${d.counts.guidelines} guidelines and ${d.counts.drugs} formulary entries from edition ${d.version}. Every question links back here.` }),
      el('div', { style: { marginTop: 'var(--sp-4)' } }, [input]),
    ]),
    listEl, moreEl,
  );
  paint(q);
}

function renderItem({ path }) {
  const id = decodeURIComponent(path.split('/item/')[1] || '');
  const d = getData();
  const g = d.glById.get(id);
  const drug = d.content.drugs.find((x) => x.id === id);
  if (!g && !drug) return renderNotFound();

  if (drug) {
    return mount(view,
      el('.page-head', {}, [
        el('a.btn.btn-ghost.btn-sm', { href: '#/browse', text: '← Browse' }),
        el('h1', { text: `${drug.number} ${drug.name}` }),
        el('p', { text: `Formulary · page ${drug.page} · edition ${d.version}` }),
      ]),
      drug.doses.length ? el('.card', { style: { marginBottom: 'var(--sp-5)', overflowX: 'auto' } }, [
        el('h3', { text: 'Dosing' }),
        el('table.dose-table', {}, [
          el('thead', {}, [el('tr', {}, ['Indication', 'Adult', 'Pediatric', 'Neonatal']
            .map((h) => el('th', { text: h })))]),
          el('tbody', {}, drug.doses.map((r) => el('tr', {}, [
            el('td', { text: r.indication.replace(/\n/g, ' ') }),
            el('td', { text: r.adult.replace(/\n/g, ' ') }),
            el('td', { text: r.pediatric.replace(/\n/g, ' ') }),
            el('td', { text: r.neonatal.replace(/\n/g, ' ') }),
          ]))),
        ]),
      ]) : null,
      Object.keys(drug.info).length ? el('.card', {}, [
        el('h3', { text: 'Drug information' }),
        el('dl.kv', {}, Object.entries(drug.info).flatMap(([k, v]) => [
          el('dt', { text: k }), el('dd', { text: v }),
        ])),
      ]) : null,
    );
  }

  // Render the nested outline rather than a flat bullet list: the indent is
  // what tells you which dose belongs to which condition.
  const LEVEL_LABEL = { BODY: 'Assessment', BLS: 'BLS', ALS: 'ALS',
                        CCT: 'CCT', PEARLS: 'Pearls' };

  function outline(items) {
    const wrap = el('.outline');
    for (const it of items) {
      if (it.kind === 'heading') {
        wrap.append(el('h4.ol-head', { text: it.text, dataset: { d: String(it.depth) } }));
      } else {
        wrap.append(el('div.ol-item', { dataset: { d: String(Math.min(it.depth, 3)) } }, [
          el('span.ol-dot', { 'aria-hidden': 'true' }),
          el('span', { text: it.text }),
        ]));
      }
    }
    return wrap;
  }

  const bands = (g.structure && g.structure.length)
    ? g.structure
    : g.blocks.filter((b) => b.bullets.length).map((b) => ({
        care_level: b.care_level, page: b.page,
        items: b.bullets.map((t) => ({ depth: 1, text: t, kind: 'item' })),
      }));

  mount(view,
    el('.page-head', {}, [
      el('a.btn.btn-ghost.btn-sm', { href: '#/browse', text: '← Browse' }),
      el('h1', { text: `${g.number} ${g.title}` }),
      el('p', { text: `${g.section_title} · page ${g.page} · edition ${d.version}` }),
    ]),
    el('.gl-nav', {}, bands.map((b, i) => el('a.chip', {
      href: `#gl-band-${i}`,
      class: b.care_level !== 'BODY' ? `chip-${b.care_level.toLowerCase()}` : '',
      text: LEVEL_LABEL[b.care_level] || b.care_level,
    }))),
    ...bands.map((b, i) => el('.card.gl-band', {
      id: `gl-band-${i}`,
      dataset: { lvl: b.care_level.toLowerCase() },
    }, [
      el('.gl-band-head', {}, [
        el('h3', { text: LEVEL_LABEL[b.care_level] || b.care_level }),
        el('span.gl-page', { text: `p.${b.page}` }),
      ]),
      outline(b.items),
    ])),
    g.images.length ? el('.card', {}, [
      el('h3', { text: 'Figures' }),
      el('.figs', {}, g.images.map((f) => el('img', {
        src: `data/images/${f}`, alt: `Figure from ${g.title}`, loading: 'lazy',
      }))),
    ]) : null,
  );
}

/* -------------------------------------------------------- settings view */
function renderSettings() {
  const s = store.getSettings();
  const d = getData();

  const num = (key, label, hint, min, max) => el('.setting-row', {}, [
    el('div', {}, [el('strong', { text: label }), el('.s', { text: hint, style: { color: 'var(--text-3)', fontSize: 'var(--fs-sm)' } })]),
    el('input', {
      type: 'number', value: s[key], min, max, class: 'num',
      onchange: (e) => {
        const v = Math.max(min, Math.min(max, parseInt(e.target.value || '0', 10)));
        e.target.value = v; store.setSetting(key, v); toast(`${label}: ${v}`);
      },
    }),
  ]);

  const sw = (key, label, hint) => el('.setting-row', {}, [
    el('div', {}, [el('strong', { text: label }), el('.s', { text: hint, style: { color: 'var(--text-3)', fontSize: 'var(--fs-sm)' } })]),
    el('label.switch', {}, [
      el('input', { type: 'checkbox', checked: !!s[key],
        onchange: (e) => { store.setSetting(key, e.target.checked); toast(`${label} ${e.target.checked ? 'on' : 'off'}`); } }),
      el('span.track'),
    ]),
  ]);

  const fileInput = el('input', {
    type: 'file', accept: 'application/json', style: { display: 'none' },
    onchange: async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const text = await f.text();
      const merge = await confirmDialog({
        title: 'Merge or replace?',
        body: 'Merge keeps your current progress and adds anything newer from the file. Replace discards what is here now.',
        okLabel: 'Merge',
      });
      const res = store.importProgress(text, { merge });
      if (!res.ok) { toast(res.error); return; }
      toast(`Imported ${res.summary.reviews} reviews across ${res.summary.cards} cards`);
      navigate('/');
      renderHome();
    },
  });

  mount(view,
    el('.page-head', {}, [el('h1', { text: 'Settings' })]),

    el('.card', { style: { marginBottom: 'var(--sp-5)' } }, [
      el('h3', { text: 'Appearance' }),
      el('.setting-row', {}, [
        el('div', {}, [el('strong', { text: 'Theme' }), el('.s', { text: 'Auto follows your device.', style: { color: 'var(--text-3)', fontSize: 'var(--fs-sm)' } })]),
        el('.seg', {}, ['auto', 'light', 'dark'].map((t) => el('button', {
          text: t[0].toUpperCase() + t.slice(1), 'aria-pressed': String((s.theme || 'auto') === t),
          onclick: () => { applyTheme(t); renderSettings(); },
        }))),
      ]),
    ]),

    el('.card', { style: { marginBottom: 'var(--sp-5)' } }, [
      el('h3', { text: 'Scheduling' }),
      num('dailyNew', 'New cards per day', 'How fast new material enters rotation. Lower is steadier.', 0, 100),
      num('dailyMax', 'Maximum reviews per day', 'Caps a session so a backlog never becomes unmanageable.', 10, 500),
      el('.setting-row', {}, [
        el('div', {}, [el('strong', { text: 'Target retention' }),
          el('.s', { text: 'Higher means shorter intervals and more reviews.', style: { color: 'var(--text-3)', fontSize: 'var(--fs-sm)' } })]),
        el('.seg', {}, [0.85, 0.9, 0.95].map((r) => el('button', {
          text: `${r * 100}%`, 'aria-pressed': String((s.desiredRetention || 0.9) === r),
          onclick: () => { store.setSetting('desiredRetention', r); renderSettings(); toast(`Target retention ${r * 100}%`); },
        }))),
      ]),
      sw('showLowConfidence', 'Include low-confidence questions',
         'Auto-generated items flagged as uncertain. Off by default.'),
    ]),

    el('.card', { style: { marginBottom: 'var(--sp-5)' } }, [
      el('h3', { text: 'Your progress' }),
      el('p', { style: { color: 'var(--text-2)', fontSize: 'var(--fs-sm)' },
        text: `${Object.keys(store.allCards()).length} cards started · ${store.getLog().length} reviews recorded · stored only in this browser.` }),
      el('div', { style: { display: 'flex', gap: 'var(--sp-3)', flexWrap: 'wrap' } }, [
        el('button.btn', { text: 'Export progress', onclick: () => { store.downloadProgress(); toast('Exported'); } }),
        el('button.btn', { text: 'Import progress', onclick: () => fileInput.click() }),
        el('button.btn.btn-danger', {
          text: 'Reset progress',
          onclick: async () => {
            const ok = await confirmDialog({
              title: 'Reset all progress?',
              body: 'Every card state and review is deleted from this browser. Export first if you want a copy. This cannot be undone.',
              danger: true, okLabel: 'Reset everything',
            });
            if (!ok) return;
            store.resetProgress({ keepSettings: true });
            toast('Progress reset'); navigate('/'); renderHome();
          },
        }),
        fileInput,
      ]),
    ]),

    el('.card', {}, [
      el('h3', { text: 'About this deck' }),
      el('dl.kv', {}, [
        el('dt', { text: 'Guidelines edition' }), el('dd', { text: d.version }),
        el('dt', { text: 'Questions' }), el('dd', { text: `${d.counts.questions.toLocaleString()} across ${d.counts.modules} modules` }),
        el('dt', { text: 'Content' }), el('dd', { text: `${d.counts.guidelines} guidelines, ${d.counts.drugs} formulary entries` }),
        el('dt', { text: 'Generated' }), el('dd', { text: new Date(d.generated).toLocaleDateString() }),
      ]),
      el('p', { style: { color: 'var(--text-3)', fontSize: 'var(--fs-sm)', marginTop: 'var(--sp-4)' },
        text: 'Every question is generated from the published guidelines and carries its source section and page. This is a study aid, not a clinical reference — treat the current published guidelines as authoritative.' }),
    ]),
  );
}

function renderNotFound() {
  mount(view, el('.empty', {}, [
    el('h3', { text: 'Nothing here' }),
    el('p', { text: 'That page does not exist.' }),
    el('a.btn.btn-primary', { href: '#/', text: 'Go home' }),
  ]));
}

/* ------------------------------------------------------------- bootstrap */
async function boot() {
  store.loadProgress();
  try {
    await loadData();
  } catch (err) {
    mount(view, el('.empty', {}, [
      el('h3', { text: 'Could not load the question bank' }),
      el('p', { text: String(err.message || err) }),
      el('p', { style: { color: 'var(--text-3)', fontSize: 'var(--fs-sm)' },
        text: 'If you opened index.html directly from disk, some browsers block local fetches. Serve the folder (for example: python3 -m http.server) or use the hosted copy.' }),
    ]));
    return;
  }
  const d = getData();
  document.getElementById('ver').textContent = d.version;

  route('/', renderHome);
  route('/modules', renderModules);
  route('/browse', renderBrowse);
  route('/settings', renderSettings);
  route('/study', (r) => import('./quiz.js').then((m) => m.mountQuiz(view, deps, r)));
  route('/stats', (r) => import('./analytics.js').then((m) => m.mountAnalytics(view, deps, r)));
  setNotFound((r) => (r.path.startsWith('/item/') ? renderItem(r) : renderNotFound()));

  bus.on('progress:reset', renderHome);
  start();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
