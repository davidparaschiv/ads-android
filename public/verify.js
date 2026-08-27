// @ts-check
const token = new URLSearchParams(window.location.hash.slice(1)).get('token') || '';
window.history.replaceState(null, '', window.location.pathname);
if (/^RZ[EA]-[A-F0-9]{64}$/.test(token)) {
  const link = document.getElementById('open');
  link.setAttribute('href', 'ro.rezerva.app://enrollment?token=' + encodeURIComponent(token)); link.hidden = false;
  document.getElementById('token').textContent = token;
} else document.getElementById('status').textContent = 'Link invalid. Solicită un link nou în aplicație.';
