// @ts-check

/** @param {unknown} value */
export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

/** @param {ParentNode} root @param {string} selector */
export function one(root, selector) {
  const element = root.querySelector(selector);
  if (!(element instanceof HTMLElement)) throw new Error(`Element lipsă: ${selector}`);
  return element;
}

/** @param {ParentNode} root @param {string} selector @param {(event: Event) => void} handler */
export function on(root, selector, handler) {
  root.querySelectorAll(selector).forEach((element) => element.addEventListener('click', handler));
}

/** @param {HTMLFormElement} form */
export function formData(form) {
  trimTextFields(form);
  return Object.fromEntries(new FormData(form).entries());
}

const trimmedInputTypes = new Set(['text', 'email', 'tel', 'search', 'url']);

/** Strip only leading/trailing whitespace from user-entered textual controls. */
export function trimTextControl(control) {
  if (control instanceof HTMLTextAreaElement
    || control instanceof HTMLInputElement && trimmedInputTypes.has(control.type)) {
    control.value = control.value.trim();
  }
}

/** @param {ParentNode} root */
export function trimTextFields(root) {
  root.querySelectorAll('input, textarea').forEach(trimTextControl);
}

/** @param {string} value */
export function formatDate(value) {
  return new Intl.DateTimeFormat('ro-RO', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${value}T12:00:00`));
}

/** @param {number} minutes */
export function reminderLabel(minutes) {
  if (minutes === 1440) return 'Cu o zi înainte';
  if (minutes >= 60) return `Cu ${minutes / 60} ${minutes === 60 ? 'oră' : 'ore'} înainte`;
  return `Cu ${minutes} minute înainte`;
}
