/**
 * main.js — application shell: boot, theming, routing, and the views the
 * shell owns (home, modules, browse, settings). Quiz and analytics are
 * mounted from their own modules through the documented interface.
 */
import { loadData, getData, enabledQuestions, taxonomies, taxonomyById,
         moduleById, sourceLabel, applyLearnerEdits } from './data.js';
import * as store from './store.js';
import * as srs from './srs.js';
import { route, setNotFound, start, navigate, bus, parse } from './router.js';
import { el, mount, clear, toast, humanDays, relTime, plural, confirmDialog } from './ui.js';
import * as search from './search.js';

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

  const nOn = enabled.size;
  const clearAll = () => {
    const before = [...enabled];
    store.setEnabledModules([]);
    toast(`Cleared ${before.length === 1 ? '1 module' : `${before.length} modules`}`, 6000, {
      label: 'Undo', onclick: () => { store.setEnabledModules(before); renderModules({ params }); },
    });
    renderModules({ params });
  };

  const header = el('.page-head', {}, [
    el('.page-head-row', {}, [
      el('h1', { text: 'Modules' }),
      el('button.btn.btn-sm', {
        type: 'button', disabled: nOn === 0,
        title: 'Switch off every module, in all groupings',
        text: nOn ? `Clear all (${nOn} on)` : 'Nothing on',
        onclick: clearAll,
      }),
    ]),
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
    sectionList(m),
    el('.meter', { style: { marginTop: 'var(--sp-3)' } }, [el('i', { style: { width: `${prog * 100}%` } })]),
    el('.modcard-foot', {}, [
      el('span', { text: `${seen}/${m.question_count} seen` }),
      locked.length ? el('span.chip', { text: 'builds on earlier part' }) : null,
    ]),
  ]);
}

/** The guidelines a module covers, as "number  title" rows, so a module reads
 *  as "Pain Management, Post-Intubation Sedation…" rather than "2.07–2.09". */
function sectionList(m) {
  const secs = Array.isArray(m.sections) ? m.sections : [];
  if (!secs.length || (secs.length === 1 && String(m.id).startsWith('focus-'))) return null;
  const MAX = 6;
  const shown = secs.length > MAX ? secs.slice(0, MAX - 1) : secs;
  return el('ul.modcard-secs', {}, [
    ...shown.map((x) => el('li', { title: `${x.number} ${x.title || ''}` }, [
      el('span.modcard-num', { text: x.number }),
      el('span', { text: x.title || '' }),
    ])),
    secs.length > shown.length
      ? el('li.modcard-more', { text: `+ ${secs.length - shown.length} more sections` }) : null,
  ]);
}

/* ---------------------------------------------------------- browse view */
function renderBrowse({ params }) {
  const d = getData();
  const q = (params.q || '').trim();

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
  const statusEl = el('.search-status');

  function row(i, snip, matched) {
    const parts = [
      el('span.browse-num', { text: i.number }),
      el('span.browse-title', { text: i.title }),
      el('span.browse-sub', { text: i.sub }),
      el('span', {}, (i.levels || []).map((l) => el(`span.chip.chip-${l.toLowerCase()}`, { text: l }))),
    ];
    const a = el('a.browse-row', { href: `#/item/${i.id}` }, parts);
    if (!snip) return a;
    // A hit inside the body is only useful if you can see what matched, so the
    // best-matching line comes along with the result.
    return el('a.browse-row.has-snip', { href: `#/item/${i.id}` }, [
      ...parts,
      el('.browse-snip', {}, [
        snip.level && snip.level !== 'BODY'
          ? el(`span.chip.chip-${snip.level.toLowerCase()}`, { text: snip.level }) : null,
        el('span', {}, highlight(snip.text, matched)),
      ].filter(Boolean)),
    ]);
  }

  function highlight(text, matched) {
    const frag = document.createDocumentFragment();
    if (!matched || !matched.length) { frag.append(text); return frag; }
    const toks = search.tokenize(text);
    const words = text.split(/(\s+)/);
    let ti = 0;
    for (const w of words) {
      if (/^\s+$/.test(w)) { frag.append(w); continue; }
      const t = search.tokenize(w)[0];
      if (t && matched.includes(t)) frag.append(el('mark', { text: w }));
      else frag.append(w);
      ti++;
    }
    return frag;
  }

  function paint(q) {
    clear(listEl);
    let hits, snips = new Map(), matched = new Map();

    if (!q) {
      hits = items;
      statusEl.textContent = `${items.length} guidelines and formulary entries`;
    } else if (search.isReady()) {
      const res = search.search(q, { limit: 60 });
      hits = res.map((r) => byId.get(r.doc.id)).filter(Boolean);
      res.forEach((r) => { if (r.snippet) snips.set(r.doc.id, r.snippet);
                           matched.set(r.doc.id, r.matched); });
      statusEl.textContent = res.length
        ? `${res.length} match${res.length === 1 ? '' : 'es'} — searching full text${search.hasSemantic() ? ' and related wording' : ''}`
        : '';
    } else {
      const lq = q.toLowerCase();
      hits = items.filter((i) => i.title.toLowerCase().includes(lq) || i.number.includes(lq));
      statusEl.textContent = `${hits.length} title matches`;
    }

    if (!hits.length) {
      statusEl.textContent = '';
      listEl.append(el('.empty', { style: { padding: 'var(--sp-8)' } }, [
        el('h3', { text: 'No matches' }),
        el('p', { text: `Nothing matches “${q}”. Try a guideline number, a drug name, a symptom, or plain words like “can't intubate”.` }),
      ]));
    } else {
      for (const i of hits.slice(0, 60)) {
        listEl.append(row(i, snips.get(i.id), matched.get(i.id)));
      }
    }
    moreEl.textContent = hits.length > 60
      ? `Showing first 60 of ${hits.length}. Narrow the search to see more.` : '';
    const want = q ? `#/browse?q=${encodeURIComponent(q)}` : '#/browse';
    if (location.hash !== want) history.replaceState(null, '', want);
  }

  const byId = new Map(items.map((i) => [i.id, i]));

  const input = el('input.search', {
    type: 'search', placeholder: 'Search guidelines, drugs, symptoms…',
    value: params.q || '', 'aria-label': 'Search content',
    autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false',
    oninput: (e) => paint(e.target.value.trim()),
  });

  mount(view,
    el('.page-head', {}, [
      el('h1', { text: 'Browse the guidelines' }),
      el('p', { text: `All ${d.counts.guidelines} guidelines and ${d.counts.drugs} formulary entries from edition ${d.version}. Search covers the full text of every section, not just titles.` }),
      el('div', { style: { marginTop: 'var(--sp-4)' } }, [input]),
      statusEl,
    ]),
    listEl, moreEl,
  );

  paint(q);
  // The index builds from content.json already in memory; it takes a moment,
  // so the first paint uses title matching and re-paints once it is ready.
  search.initSearch(d.content).then(() => { if (input.value.trim()) paint(input.value.trim()); })
    .catch((err) => console.warn('search unavailable', err));
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
  // BODY is the unbanded part of a page: the History/Assessment box on a
  // guideline, but the whole page on a reference chart.
  const isAssess = (b) => b.items.some((i) => i.kind === 'heading'
    && /^(history|assessment|differential)$/i.test(i.text));
  const bodyLabel = (b) => (isAssess(b) ? 'Assessment'
    : g.section_number === '10' ? 'Reference' : 'Overview');
  const LEVEL_LABEL = { BLS: 'BLS', ALS: 'ALS', CCT: 'CCT', PEARLS: 'Pearls' };
  const bandLabel = (b) => (b.care_level === 'BODY' ? bodyLabel(b)
    : LEVEL_LABEL[b.care_level] || b.care_level);

  function outline(items) {
    const wrap = el('.outline');
    for (const it of items) {
      if (it.kind === 'table') {
        wrap.append(refTable(it, g));
      } else if (it.kind === 'figure') {
        wrap.append(el('figure.ref-fig', {}, [
          el('button.ref-imgbtn', { type: 'button', 'aria-label': 'Enlarge figure',
            onclick: () => openZoom(`data/${it.image}`, `Figure from ${g.title}`) }, [
            el('img.ref-img', { src: `data/${it.image}`, alt: `Figure from ${g.title}`, loading: 'lazy' })]),
          el('figcaption', { text: 'Tap to enlarge' }),
        ]));
      } else if (it.kind === 'heading') {
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

  // Figures already placed inline (vector diagrams) are not repeated below.
  const inline = new Set(bands.flatMap((b) => b.items)
    .filter((i) => i.kind === 'figure')
    .flatMap((i) => [i.image.replace(/^images\//, ''), ...(i.covers || [])]));
  const figs = g.images.filter((f) => !inline.has(f));

  mount(view,
    el('.page-head', {}, [
      el('a.btn.btn-ghost.btn-sm', { href: '#/browse', text: '← Browse' }),
      el('h1', { text: `${g.number} ${g.title}` }),
      el('p', { text: `${g.section_title} · page ${g.page} · edition ${d.version}` }),
    ]),
    el('.gl-nav', {}, bands.map((b, i) => el('a.chip', {
      href: `#gl-band-${i}`,
      class: b.care_level !== 'BODY' ? `chip-${b.care_level.toLowerCase()}` : '',
      text: bandLabel(b),
    }))),
    ...bands.map((b, i) => el('.card.gl-band', {
      id: `gl-band-${i}`,
      dataset: { lvl: b.care_level.toLowerCase() },
    }, [
      el('.gl-band-head', {}, [
        el('h3', { text: bandLabel(b) }),
        el('button.gl-page', {
          type: 'button', title: 'View the original page',
          text: `View page ${b.page}`,
          onclick: () => openZoom(`data/pages/p${String(b.page).padStart(3, '0')}.webp`,
            `${g.number} ${g.title}, page ${b.page}`),
        }),
      ]),
      outline(b.items),
    ])),
    figs.length ? el('.card', {}, [
      el('h3', { text: 'Figures' }),
      el('.figs', {}, figs.map((f) => el('img', {
        src: `data/images/${f}`, alt: `Figure from ${g.title}`, loading: 'lazy',
      }))),
    ]) : null,
  );
}

/** A data table from the guideline. Checked tables render as rows and columns
 *  (stacked into one card per row on a phone); the rest show the original
 *  table image, since a mis-gridded table would put a value beside the wrong
 *  parameter. Either way the original is one tap away. */
function refTable(it, g) {
  const img = () => el('img.ref-img', {
    src: `data/${it.image}`, alt: `Table from ${g.title}`, loading: 'lazy',
    style: { aspectRatio: String(it.aspect || '') },
  });
  const zoom = () => openZoom(`data/${it.image}`, `Table from ${g.title}`);

  if (it.render !== 'html') {
    return el('figure.ref-fig', {}, [
      el('button.ref-imgbtn', { type: 'button', 'aria-label': 'Enlarge table', onclick: zoom }, [img()]),
      el('figcaption', { text: 'Tap to enlarge' }),
    ]);
  }
  const head = it.header || null;
  const cell = (tag, text, label) => el(tag, label ? { dataset: { label } } : {},
    String(text || '').split('\n').map((ln) => (ln.startsWith('\u0001')
      ? el('strong.ref-line.ref-sub', { text: ln.slice(1) })
      : el('span.ref-line', { text: ln }))));
  const plain = (x) => String(x || '').replace(/\u0001/g, '');
  const table = el('table.ref-table', { dataset: { cols: String((head || it.rows[0] || []).length) } }, [
    head ? el('thead', {}, [el('tr', {}, head.map((h) => el('th', { text: plain(h) })))]) : null,
    el('tbody', {}, it.rows.map((r) => el('tr', {}, r.map((c, j) =>
      cell(j === 0 ? 'th' : 'td', c, head && j > 0 ? plain(head[j]) : ''))))),
  ]);
  if (head) table.querySelectorAll('tbody th').forEach((th) => th.setAttribute('scope', 'row'));
  return el('figure.ref-fig', {}, [
    el('.ref-scroll', {}, [table]),
    el('button.btn.btn-ghost.btn-sm.ref-orig', { type: 'button', text: 'View original table', onclick: zoom }),
  ]);
}

/** Full-screen image viewer: fit to screen, tap to toggle actual size. */
function openZoom(src, alt) {
  let actual = false;
  const im = el('img', { src, alt });
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const ov = el('.zoom', { role: 'dialog', 'aria-modal': 'true', 'aria-label': alt }, [
    el('.zoom-bar', {}, [
      el('button.btn.btn-sm', { type: 'button', text: 'Actual size', onclick: (e) => {
        actual = !actual; ov.classList.toggle('zoom-actual', actual);
        e.currentTarget.textContent = actual ? 'Fit to screen' : 'Actual size';
      } }),
      el('button.btn.btn-sm', { type: 'button', text: 'Close', onclick: close }),
    ]),
    el('.zoom-body', {}, [im]),
  ]);
  document.addEventListener('keydown', onKey);
  document.body.append(ov);
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


/* ---------------------------------------------------------- review view */
const FLAG_LABEL = {
  wrong: 'Answer looks wrong', ambiguous: 'More than one answer fits',
  unclear: 'Confusing wording', outdated: 'Does not match the guideline',
  other: 'Flagged',
};

function renderReview({ params }) {
  const d = getData();
  const tab = params.tab || 'flagged';
  const flagged = store.getFlagged();
  const edits = store.getEdits();
  const suppressed = store.getSuppressed();

  const sets = {
    flagged: Object.keys(flagged),
    edited: Object.keys(edits),
    removed: Object.keys(suppressed),
  };
  const ids = (sets[tab] || []).filter((id) => d.qById.has(id));

  const tabs = el('.seg', { style: { marginTop: 'var(--sp-4)' } },
    [['flagged', 'Flagged'], ['edited', 'Edited'], ['removed', 'Removed']]
      .map(([k, lab]) => el('button', {
        text: `${lab} (${sets[k].length})`, 'aria-pressed': String(k === tab),
        onclick: () => navigate(`/review?tab=${k}`),
      })));

  const body = ids.length
    ? el('.review-list', {}, ids.map((id) => reviewCard(d.qById.get(id), tab)))
    : el('.empty', {}, [
        el('h3', { text: {
          flagged: 'Nothing flagged', edited: 'No edits yet',
          removed: 'Nothing removed',
        }[tab] }),
        el('p', { text: {
          flagged: 'When a question looks wrong while you are studying, tap "Flag this question" on the answer screen and it lands here.',
          edited: 'Questions you rewrite keep their scheduling history and show an "edited" mark. Your edits live in this browser and survive content updates.',
          removed: 'Removed questions stop appearing in study sessions but are never destroyed — you can restore any of them here.',
        }[tab] }),
        el('a.btn.btn-primary', { href: '#/study', text: 'Go study' }),
      ]);

  mount(view,
    el('.page-head', {}, [
      el('h1', { text: 'Review questions' }),
      el('p', { text: 'Fix or remove questions that do not hold up. Changes are stored with your progress, not in the shipped question bank, so they survive a content rebuild and travel with your export.' }),
      tabs,
    ]),
    body,
  );
}

function reviewCard(q, tab) {
  const wrap = el('.card.review-card');

  function readMode() {
    const flag = store.getFlagged()[q.id];
    const sup = store.getSuppressed()[q.id];
    wrap.replaceChildren(
      el('.review-head', {}, [
        el('span.chip', { text: `${q.source.number} · p.${q.source.page}` }),
        el('span.chip', { text: q.type }),
        q.edited ? el('span.chip.chip-due', { text: 'edited' }) : null,
        flag ? el('span.chip.chip-new', { text: FLAG_LABEL[flag.reason] || 'flagged' }) : null,
        sup ? el('span.chip.chip-new', { text: 'removed from study' }) : null,
      ].filter(Boolean)),
      el('p.review-stem', { text: q.stem }),
      el('ol.review-opts', {}, q.options.map((o, i) => el('li', {
        class: i === q.answer ? 'is-answer' : '', text: o,
      }))),
      q.explanation ? el('p.review-expl', { text: q.explanation }) : null,
      el('.review-actions', {}, [
        el('button.btn.btn-sm.btn-primary', { text: 'Edit', onclick: editMode }),
        tab === 'removed'
          ? el('button.btn.btn-sm', { text: 'Restore to study',
              onclick: () => { store.restoreQuestion(q.id); refresh(); } })
          : el('button.btn.btn-sm.btn-danger', { text: 'Remove from study',
              onclick: async () => {
                const ok = await confirmDialog({
                  title: 'Remove this question?',
                  body: 'It stops appearing in study sessions. Nothing is destroyed — you can restore it from the Removed tab at any time.',
                  danger: true, okLabel: 'Remove',
                });
                if (ok) { store.suppressQuestion(q.id); refresh(); }
              } }),
        store.getFlagged()[q.id]
          ? el('button.btn.btn-sm', { text: 'Clear flag',
              onclick: () => { store.unflagQuestion(q.id); refresh(); } })
          : null,
        q.edited
          ? el('button.btn.btn-sm', { text: 'Revert to original',
              onclick: () => { store.saveEdit(q.id, null); refresh(); } })
          : null,
        el('a.btn.btn-sm.btn-ghost', { href: `#/item/${sourceItemId(q)}`, text: 'Open source →' }),
      ].filter(Boolean)),
    );
  }

  function editMode() {
    const stem = el('textarea.review-input', { rows: 3, value: q.stem });
    const opts = q.options.map((o) => el('input.review-input', { type: 'text', value: o }));
    let answer = q.answer;
    const radios = opts.map((inp, i) => el('label.review-opt-row', {}, [
      el('input', {
        type: 'radio', name: `ans-${q.id}`, checked: i === q.answer,
        onchange: () => { answer = i; },
      }),
      inp,
    ]));
    const expl = el('textarea.review-input', { rows: 3, value: q.explanation || '' });

    wrap.replaceChildren(
      el('.review-head', {}, [el('span.chip', { text: `${q.source.number} · p.${q.source.page}` })]),
      el('label.review-label', { text: 'Question' }), stem,
      el('label.review-label', { text: 'Options — select the correct one' }),
      ...radios,
      el('label.review-label', { text: 'Explanation' }), expl,
      el('p', { style: { color: 'var(--text-3)', fontSize: 'var(--fs-xs)' },
        text: 'Check your wording against the cited page before saving. This edit replaces the question everywhere it appears, and keeps its scheduling history.' }),
      el('.review-actions', {}, [
        el('button.btn.btn-sm.btn-primary', {
          text: 'Save', onclick: () => {
            const vals = opts.map((o) => o.value.trim());
            if (!stem.value.trim()) { toast('The question cannot be empty'); return; }
            if (vals.some((v) => !v)) { toast('All four options need text'); return; }
            if (new Set(vals.map((v) => v.toLowerCase())).size !== 4) {
              toast('Options must be different from each other'); return;
            }
            store.saveEdit(q.id, { stem: stem.value.trim(), options: vals,
                                   answer, explanation: expl.value.trim() });
            toast('Saved');
            refresh();
          },
        }),
        el('button.btn.btn-sm', { text: 'Cancel', onclick: readMode }),
      ]),
    );
    stem.focus();
  }

  readMode();
  return wrap;
}

function sourceItemId(q) {
  const d = getData();
  const rec = d.glByNumber.get(q.source.number) || d.drugByNumber.get(q.source.number);
  return rec ? encodeURIComponent(rec.id) : '';
}

/** Re-apply the learner's corrections to the in-memory bank. */
function applyEdits() {
  try {
    applyLearnerEdits({ edits: store.getEdits(), suppressed: store.getSuppressed() });
  } catch (err) { console.warn('could not apply edits', err); }
}

function refresh() {
  applyEdits();
  navigate(`/review?tab=${(parse().params.tab) || 'flagged'}`, { replace: true });
  renderReview(parse());
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
  applyEdits();

  route('/', renderHome);
  route('/modules', renderModules);
  route('/browse', renderBrowse);
  route('/settings', renderSettings);
  route('/review', renderReview);
  route('/study', (r) => import('./quiz.js').then((m) => m.mountQuiz(view, deps, r)));
  route('/stats', (r) => import('./analytics.js').then((m) => m.mountAnalytics(view, deps, r)));
  setNotFound((r) => (r.path.startsWith('/item/') ? renderItem(r) : renderNotFound()));

  // Nav badge mirrors the flag count so a flag raised mid-session is visible
  // without hunting for it later.
  const badge = document.getElementById('revBadge');
  function paintBadge() {
    if (!badge) return;
    const n = store.reviewCounts().flagged;
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.hidden = n === 0;
  }
  store.onChange(() => { applyEdits(); paintBadge(); });
  paintBadge();

  bus.on('progress:reset', renderHome);
  start();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
