// @ts-check
// Only opaque reservation tokens. Never persist them in UI preferences or routes.
const TOKEN = /^RZB-[A-F0-9]{64}$/;
let pending = '';

export function parseReservationQr(value) {
  if (typeof value !== 'string' || value.length > 200) throw new Error('Codul nu este un QR de programare Rezerva.');
  const text = value.trim();
  if (TOKEN.test(text)) return text;
  let url;
  try { url = new URL(text); } catch { throw new Error('Codul nu este un QR de programare Rezerva.'); }
  const token = url.searchParams.get('token') || '';
  if (url.protocol !== 'ro.rezerva.app:' || url.hostname !== 'reservation' || url.username || url.password || url.port ||
      url.pathname !== '' || url.hash || [...url.searchParams].length !== 1 || !TOKEN.test(token)) {
    throw new Error('Codul nu este un QR de programare Rezerva.');
  }
  return token;
}
export function rememberReservationQr(value) { pending = parseReservationQr(value); }
export function hasPendingReservationQr() { return Boolean(pending); }
export function takePendingReservationQr() { const token = pending; pending = ''; return token; }
export function clearPendingReservationQr() { pending = ''; }
