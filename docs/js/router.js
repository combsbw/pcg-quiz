/** Minimal hash router + event bus. Hash routing is what lets the same build
 *  work on GitHub Pages (no server rewrites) and from a local file://. */

const routes = new Map();
let notFound = null;
let current = null;

export function route(path, handler) { routes.set(path, handler); }
export function setNotFound(fn) { notFound = fn; }

export function parse(hash = location.hash) {
  const raw = (hash || '#/').replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  const params = Object.fromEntries(new URLSearchParams(query));
  return { path: path.replace(/\/+$/, '') || '/', params };
}

export function navigate(to, { replace = false } = {}) {
  const url = to.startsWith('#') ? to : `#${to}`;
  if (replace) location.replace(url); else location.hash = url;
}

export function currentRoute() { return current; }

export function start() {
  const run = () => {
    const r = parse();
    current = r;
    const handler = routes.get(r.path) || notFound;
    document.querySelectorAll('#nav a[data-route]').forEach((a) => {
      const active = a.dataset.route === r.path ||
        (a.dataset.route !== '/' && r.path.startsWith(a.dataset.route));
      if (active) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    if (handler) handler(r);
  };
  addEventListener('hashchange', run);
  run();
}

/* ------------------------------------------------------------------ bus */
export const bus = (() => {
  const map = new Map();
  return {
    on(evt, fn) {
      if (!map.has(evt)) map.set(evt, new Set());
      map.get(evt).add(fn);
      return () => map.get(evt).delete(fn);
    },
    emit(evt, payload) {
      (map.get(evt) || []).forEach((fn) => {
        try { fn(payload); } catch (e) { console.error(`bus ${evt}`, e); }
      });
    },
  };
})();
