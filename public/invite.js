// @ts-check
// Token is in the URL fragment, never the query string sent to this web server.
const value = new URLSearchParams(window.location.hash.slice(1)).get('token') || '';
window.history.replaceState(null, '', window.location.pathname);
if (/^RZI-[A-F0-9]{64}$/i.test(value)) {
  const link = document.getElementById('open');
  link.setAttribute('href', 'ro.rezerva.app://invite?token=' + encodeURIComponent(value));
  link.hidden = false;
  document.getElementById('token').textContent = value;
} else document.getElementById('status').textContent = 'Invitație invalidă. Cere proprietarului să o retrimită.';
