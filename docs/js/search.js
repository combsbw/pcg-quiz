/**
 * search.js — offline hybrid search over the guidelines.
 *
 * Three signals, combined:
 *
 *  1. **Field-weighted keyword match.** BM25 over the body, plus a title hit
 *     weighted by the term's idf. Weighting the title by rarity matters: a
 *     query for "snake bite" should not rank "Hypothermia & Frost Bite" first
 *     just because "bite" is in its title, when "snake" appears in exactly one
 *     section.
 *
 *  2. **Vocabulary expansion.** Two sources, both offline: the document's own
 *     abbreviation glossary (10.02 — AMS, LVO, LTOWB…) and a small curated map
 *     of lay terms the guidelines never use ("sugar" → glucose/BGL).
 *
 *  3. **Latent semantic similarity.** The build step factorises the TF-IDF
 *     matrix and ships term and document vectors, so a query can be embedded
 *     and scored with dot products — no model, no download. This supplies
 *     recall when the wording does not overlap, and is weighted low because on
 *     a 201-document corpus it is informative but noisy.
 *
 * Everything here runs against two JSON files already on disk, so it works
 * from a home-screen icon with the radio off.
 */

let IDX = null;      // search.json
let CORPUS = null;   // derived from content.json

const STOP = new Set(('a an and are as at be by for from in into is it of on or the to with ' +
  'that this these those was were will would should could can do does did ' +
  'what which who whom how when where why if then than there here i me my ' +
  'we our you your they them his her its it\'s dont don\'t cant can\'t wont won\'t').split(' '));

const TOKEN = /[a-z][a-z0-9/%+-]{1,}/g;

function stem(w) {
  for (const suf of ['ization', 'ations', 'ation', 'ingly', 'ings', 'ing',
                     'ies', 'ied', 'es', 'ed', 'ly', 's']) {
    if (w.length > suf.length + 3 && w.endsWith(suf)) return w.slice(0, -suf.length);
  }
  return w;
}

export function tokenize(text) {
  const out = [];
  const s = (text || '').toLowerCase();
  let m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(s))) {
    const w = m[0].replace(/^[-/+]+|[-/+]+$/g, '');
    if (w.length < 2 || STOP.has(w)) continue;
    out.push(stem(w));
  }
  return out;
}

function b64ToInt8(b64) {
  const bin = atob(b64);
  const arr = new Int8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = (bin.charCodeAt(i) << 24) >> 24;
  return arr;
}

/** Text of one record, mirroring what the build step indexed. */
function recordText(rec, kind) {
  const parts = [];
  if (kind === 'guideline') {
    for (const b of rec.structure || []) for (const it of b.items) parts.push(it.text);
    if (!rec.structure) for (const b of rec.blocks || []) parts.push(...(b.bullets || []));
  } else {
    for (const d of rec.doses || []) parts.push(d.indication, d.adult, d.pediatric, d.neonatal);
    for (const [k, v] of Object.entries(rec.info || {})) parts.push(k, v);
  }
  return parts.filter(Boolean).join('\n');
}

/** Lines a snippet can be drawn from. */
function recordLines(rec, kind) {
  const out = [];
  if (kind === 'guideline') {
    for (const b of rec.structure || []) {
      for (const it of b.items) out.push({ text: it.text, level: b.care_level });
    }
    if (!rec.structure) {
      for (const b of rec.blocks || []) {
        for (const t of b.bullets || []) out.push({ text: t, level: b.care_level });
      }
    }
  } else {
    for (const d of rec.doses || []) {
      const ind = (d.indication || '').replace(/\s+/g, ' ').trim();
      if (d.adult) out.push({ text: `${ind} — adult: ${d.adult.replace(/\n/g, ' ')}`, level: null });
      if (d.pediatric) out.push({ text: `${ind} — pediatric: ${d.pediatric.replace(/\n/g, ' ')}`, level: null });
    }
    for (const [k, v] of Object.entries(rec.info || {})) out.push({ text: `${k}: ${v}`, level: null });
  }
  return out;
}

export async function initSearch(content) {
  if (CORPUS) return;
  try {
    IDX = await (await fetch('data/search.json', { cache: 'no-cache' })).json();
  } catch (err) {
    console.warn('semantic index unavailable; keyword search only', err);
    IDX = null;
  }

  const recs = [
    ...content.guidelines.map((g) => ({ rec: g, kind: 'guideline' })),
    ...content.drugs.map((d) => ({ rec: d, kind: 'drug' })),
  ];

  const docs = recs.map(({ rec, kind }) => {
    const title = kind === 'guideline' ? rec.title : rec.name;
    const bodyToks = tokenize(recordText(rec, kind));
    const tf = new Map();
    for (const w of bodyToks) tf.set(w, (tf.get(w) || 0) + 1);
    return {
      id: rec.id, number: rec.number, title, kind,
      section: kind === 'guideline' ? rec.section_title : 'Formulary',
      page: rec.page, levels: kind === 'guideline' ? (rec.care_levels || []) : [],
      titleToks: new Set(tokenize(`${rec.number} ${title}`)),
      tf, len: bodyToks.length,
      lines: recordLines(rec, kind),
    };
  });

  const N = docs.length;
  const df = new Map();
  for (const d of docs) for (const w of d.tf.keys()) df.set(w, (df.get(w) || 0) + 1);
  for (const d of docs) for (const w of d.titleToks) if (!d.tf.has(w)) df.set(w, (df.get(w) || 0) + 1);
  const avgLen = docs.reduce((a, d) => a + d.len, 0) / Math.max(N, 1);

  let termVecs = null, docVecs = null, vidx = null;
  if (IDX) {
    const K = IDX.dims;
    const tv = b64ToInt8(IDX.termVecs), dv = b64ToInt8(IDX.docVecs);
    termVecs = { data: tv, scale: IDX.termScale, K };
    docVecs = { data: dv, scale: IDX.docScale, K };
    vidx = new Map(IDX.vocab.map((w, i) => [w, i]));
  }

  // Sorted corpus vocabulary, for prefix completion while the user is still
  // typing. Live search is useless without it: "epineph" must already be
  // finding Epinephrine before the word is finished.
  const allTerms = [...df.keys()].sort();

  CORPUS = { docs, N, df, avgLen, termVecs, docVecs, vidx, allTerms,
             byId: new Map(docs.map((d, i) => [d.id, i])) };
}

const idf = (w) => {
  const n = CORPUS.df.get(w) || 0;
  return n ? Math.log(1 + (CORPUS.N - n + 0.5) / (n + 0.5)) : 0;
};

/** Terms in the corpus beginning with `pre`, found by binary search. */
function prefixTerms(pre, cap = 12) {
  const v = CORPUS.allTerms;
  let lo = 0, hi = v.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (v[mid] < pre) lo = mid + 1; else hi = mid; }
  const out = [];
  for (let i = lo; i < v.length && v[i].startsWith(pre) && out.length < cap; i++) {
    out.push(v[i]);
  }
  return out;
}

/**
 * Expand a query with glossary abbreviations, lay-term synonyms, and — for the
 * word still being typed — prefix completions.
 */
export function expand(rawTokens, rawText, { prefixLast = true } = {}) {
  const out = new Map();                       // term -> weight
  for (const t of rawTokens) out.set(t, 1);

  if (prefixLast && rawTokens.length && CORPUS) {
    const last = rawTokens[rawTokens.length - 1];
    // Only when the typed word is not itself a known term, so a complete word
    // is never diluted by its own longer neighbours.
    if (last.length >= 3 && !CORPUS.df.has(last)) {
      for (const t of prefixTerms(last)) if (!out.has(t)) out.set(t, 0.95);
    }
  }

  if (!IDX) return out;
  const compact = (rawText || '').toLowerCase().replace(/[^a-z]/g, '');

  for (const t of rawTokens) {
    const ab = IDX.abbrev && IDX.abbrev[t];
    if (ab) for (const w of tokenize(ab)) if (!out.has(w)) out.set(w, 0.8);
    const syn = IDX.synonyms && IDX.synonyms[t];
    if (syn) for (const w of syn) if (!out.has(w)) out.set(w, 0.7);
  }
  // Multi-word lay phrases ("heart attack", "low sugar") are keyed without
  // spaces so they survive tokenisation.
  for (const [k, vs] of Object.entries(IDX.synonyms || {})) {
    if (k.length > 5 && compact.includes(k)) {
      for (const w of vs) if (!out.has(w)) out.set(w, 0.85);
    }
  }
  return out;
}

function semanticScores(weighted) {
  const { termVecs, docVecs, vidx, N } = CORPUS;
  if (!termVecs || !vidx) return null;
  const K = termVecs.K;
  const q = new Float32Array(K);
  let hits = 0;
  for (const [w, wt] of weighted) {
    const j = vidx.get(w);
    if (j === undefined) continue;
    const base = j * K;
    const iw = (IDX.idf[j] || 1) * wt;
    for (let k = 0; k < K; k++) q[k] += termVecs.data[base + k] * termVecs.scale * iw;
    hits++;
  }
  if (!hits) return null;
  let norm = 0;
  for (let k = 0; k < K; k++) norm += q[k] * q[k];
  norm = Math.sqrt(norm) || 1;
  for (let k = 0; k < K; k++) q[k] /= norm;

  const out = new Float32Array(N);
  for (let d = 0; d < N; d++) {
    const base = d * K;
    let s = 0;
    for (let k = 0; k < K; k++) s += docVecs.data[base + k] * docVecs.scale * q[k];
    out[d] = s;
  }
  return out;
}

function snippet(doc, terms) {
  let best = null, bestScore = 0;
  for (const ln of doc.lines) {
    const toks = tokenize(ln.text);
    if (!toks.length) continue;
    const set = new Set(toks);
    let s = 0;
    for (const t of terms) if (set.has(t)) s += idf(t);
    s /= Math.sqrt(toks.length);            // prefer a focused line
    if (s > bestScore) { bestScore = s; best = ln; }
  }
  return bestScore > 0 ? best : null;
}

/**
 * @returns [{doc, score, snippet, matched}] ordered best first.
 */
export function search(query, { limit = 40, semanticWeight = 0.9 } = {}) {
  if (!CORPUS) return [];
  const raw = tokenize(query);
  if (!raw.length) return [];
  const weighted = expand(raw, query);
  const terms = [...weighted.keys()];
  const nQ = raw.length;

  const sem = semanticScores(weighted);
  const scored = [];

  for (let i = 0; i < CORPUS.N; i++) {
    const d = CORPUS.docs[i];
    let bm = 0, titleScore = 0, covered = 0, rawCovered = 0;

    for (const [w, wt] of weighted) {
      const iw = idf(w);
      if (!iw) continue;
      // Title hits weighted by rarity, so a common word in a title cannot
      // outrank a rare word in the body.
      if (d.titleToks.has(w)) titleScore += iw * wt;
      const f = d.tf.get(w) || 0;
      if (f) {
        bm += iw * wt * (f * 1.4) / (f + 1.2 * (0.25 + 0.75 * d.len / CORPUS.avgLen));
        covered += wt;
      } else if (d.titleToks.has(w)) {
        covered += wt;
      }
    }
    for (const w of raw) if (d.tf.has(w) || d.titleToks.has(w)) rawCovered++;

    // Matching a word in a short title is a strong signal on its own, and must
    // not depend on that word being rare. Without a rarity-independent term,
    // the page actually *called* "Epinephrine" loses to a guideline that
    // happens to mention epinephrine a dozen times.
    let titleHits = 0;
    for (const [w] of weighted) if (d.titleToks.has(w)) titleHits++;
    const titleCov = titleHits / Math.max(Math.min(terms.length, 6), 1);
    // The query accounts for essentially the whole title ("ketamine").
    const titleSaturation = titleHits / Math.max(d.titleToks.size, 1);

    const cov = covered / Math.max(terms.length, 1);
    const rawCov = rawCovered / nQ;
    let score = 1.6 * titleScore + 0.55 * bm + 2.2 * rawCov + 0.8 * cov
              + 2.6 * titleCov + 1.4 * titleSaturation;
    if (sem) score += semanticWeight * Math.max(0, sem[i]);
    if (score <= 0) continue;
    scored.push({ i, score });
  }

  scored.sort((a, b) => b.score - a.score);

  // Relevance cutoff. Semantic recall gives every document some score, so
  // without this a two-word query returns the whole corpus in ranked order —
  // technically sorted, useless to read. Keep what is close to the best hit.
  if (scored.length) {
    const top = scored[0].score;
    const floor = Math.max(top * 0.34, 0.45);
    let keep = scored.findIndex((x) => x.score < floor);
    if (keep < 0) keep = scored.length;
    scored.length = Math.max(1, keep);
  }

  return scored.slice(0, limit).map(({ i, score }) => {
    const d = CORPUS.docs[i];
    return {
      doc: { id: d.id, number: d.number, title: d.title, kind: d.kind,
             section: d.section, page: d.page, levels: d.levels },
      score,
      snippet: snippet(d, terms),
      matched: terms.filter((t) => d.tf.has(t) || d.titleToks.has(t)),
    };
  });
}

export function isReady() { return !!CORPUS; }
export function hasSemantic() { return !!(CORPUS && CORPUS.termVecs); }
