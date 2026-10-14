/**
 * data.js — loads and indexes the generated content, questions and modules.
 *
 * Fetched once, cached in memory. Works from file:// as well as http(s) when
 * the JSON sits beside index.html, which matters because the brief asks for a
 * downloadable offline copy as well as a GitHub Pages deploy.
 */

const PATHS = {
  content: 'data/content.json',
  questions: 'data/questions.json',
  modules: 'data/modules.json',
};

let cache = null;
let loading = null;

async function getJSON(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

export async function loadData() {
  if (cache) return cache;
  if (loading) return loading;
  loading = (async () => {
    const [content, questions, modules] = await Promise.all([
      getJSON(PATHS.content), getJSON(PATHS.questions), getJSON(PATHS.modules),
    ]);

    const qById = new Map(questions.questions.map((q) => [q.id, q]));
    const modById = new Map();
    for (const t of modules.taxonomies) {
      for (const m of t.modules) modById.set(m.id, { ...m, taxonomy: t.id });
    }
    const glById = new Map(content.guidelines.map((g) => [g.id, g]));
    const glByNumber = new Map(content.guidelines.map((g) => [g.number, g]));
    const drugByNumber = new Map(content.drugs.map((d) => [d.number, d]));

    cache = {
      version: content.version,
      generated: questions.generated,
      content, questions: questions.questions, modules,
      qById, modById, glById, glByNumber, drugByNumber,
      counts: {
        questions: questions.questions.length,
        guidelines: content.guidelines.length,
        drugs: content.drugs.length,
        modules: modById.size,
      },
    };
    return cache;
  })();
  return loading;
}

export function getData() {
  if (!cache) throw new Error('loadData() must resolve before getData()');
  return cache;
}

export const questionById = (id) => getData().qById.get(id) || null;
export const moduleById = (id) => getData().modById.get(id) || null;
export const taxonomies = () => getData().modules.taxonomies;

export function taxonomyById(id) {
  return taxonomies().find((t) => t.id === id) || taxonomies()[0];
}

/** Questions in the learner's enabled modules, de-duplicated across taxonomies. */
export function enabledQuestions(settings) {
  const d = getData();
  const ids = new Set();
  for (const mid of settings.enabledModules || []) {
    const m = d.modById.get(mid);
    if (m) for (const qid of m.question_ids) ids.add(qid);
  }
  let out = [...ids].map((id) => d.qById.get(id)).filter(Boolean);
  if (!settings.showLowConfidence) out = out.filter((q) => q.confidence !== 'low');
  return out;
}

/** Source link text for a question, e.g. "12.26 Epinephrine · p.332". */
export function sourceLabel(q) {
  return `${q.source.number} ${q.source.title} · p.${q.source.page}`;
}

/** Guideline or drug record behind a question, when there is one. */
export function sourceRecord(q) {
  const d = getData();
  return d.glByNumber.get(q.source.number) || d.drugByNumber.get(q.source.number) || null;
}
