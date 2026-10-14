/** Shared DOM + formatting helpers. Import these rather than re-inventing;
 *  they keep markup and number formatting consistent across modules. */

/** el('div.card', {onclick}, [children]) — tag.class#id shorthand. */
export function el(spec, props = {}, children = []) {
  const m = /^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i.exec(spec) || [];
  const node = document.createElement(m[1] || 'div');
  for (const token of (m[2] || '').match(/[.#][\w-]+/g) || []) {
    if (token[0] === '.') node.classList.add(token.slice(1));
    else node.id = token.slice(1);
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className += ` ${v}`;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

export function mount(root, ...nodes) { clear(root); root.append(...nodes); return root; }

export function toast(msg, ms = 2600) {
  const wrap = document.getElementById('toasts');
  if (!wrap) return;
  const t = el('.toast', { text: msg, role: 'status' });
  wrap.append(t);
  setTimeout(() => {
    t.style.transition = 'opacity .25s'; t.style.opacity = '0';
    setTimeout(() => t.remove(), 260);
  }, ms);
}

/* ------------------------------------------------------------ formatting */
export const pct = (n) => `${Math.round((n || 0) * 100)}%`;

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Human interval: 0.4 -> "10h", 3 -> "3d", 45 -> "1.5mo", 400 -> "1.1y" */
export function humanDays(d) {
  if (!isFinite(d)) return '—';
  if (d < 1 / 24) return `${Math.max(1, Math.round(d * 1440))}m`;
  if (d < 1) return `${Math.round(d * 24)}h`;
  if (d < 31) return `${Math.round(d)}d`;
  if (d < 365) return `${(d / 30.4).toFixed(d < 90 ? 1 : 0)}mo`;
  return `${(d / 365).toFixed(1)}y`;
}

export function relTime(iso) {
  if (!iso) return 'never';
  const diff = (new Date(iso) - Date.now()) / 86400000;
  const a = Math.abs(diff);
  const unit = humanDays(a);
  if (a < 0.02) return 'now';
  return diff < 0 ? `${unit} ago` : `in ${unit}`;
}

export function dayKey(d = new Date()) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString().slice(0, 10);
}

export function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Confirm dialog returning a promise; avoids blocking window.confirm styling. */
export function confirmDialog({ title, body, danger = false, okLabel = 'Confirm' }) {
  return new Promise((resolve) => {
    const dlg = el('dialog.confirm-dlg', {}, [
      el('h3', { text: title }),
      el('p', { text: body, style: { color: 'var(--text-2)' } }),
      el('.row', { style: { display: 'flex', gap: 'var(--sp-3)', justifyContent: 'flex-end', marginTop: 'var(--sp-5)' } }, [
        el('button.btn', { text: 'Cancel', onclick: () => { dlg.close(); resolve(false); } }),
        el(`button.btn${danger ? '.btn-danger' : '.btn-primary'}`,
          { text: okLabel, onclick: () => { dlg.close(); resolve(true); } }),
      ]),
    ]);
    Object.assign(dlg.style, {
      border: '1px solid var(--border)', borderRadius: 'var(--r-lg)',
      background: 'var(--surface)', color: 'var(--text)',
      padding: 'var(--sp-6)', maxWidth: '420px', boxShadow: 'var(--shadow-3)',
    });
    dlg.addEventListener('close', () => dlg.remove(), { once: true });
    document.body.append(dlg);
    dlg.showModal();
  });
}
