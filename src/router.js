// @ts-check

/** @typedef {{ path: string, params: Record<string, string> }} Route */

/** @type {Set<(route: Route) => void>} */
const listeners = new Set();

export function currentRoute() {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const [path] = raw.split('?');
  return { path, params: {} };
}

export function navigate(path) {
  if (window.location.hash === `#${path}`) {
    notify();
    return;
  }
  window.location.hash = path;
}

export function back(fallback = '/') {
  if (window.history.length > 1) window.history.back();
  else navigate(fallback);
}

export function startRouter(listener) {
  listeners.add(listener);
  window.addEventListener('hashchange', notify);
  notify();
  return () => listeners.delete(listener);
}

function notify() {
  const route = currentRoute();
  listeners.forEach((listener) => listener(route));
}
