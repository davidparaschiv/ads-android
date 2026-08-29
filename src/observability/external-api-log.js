// @ts-check

const nativeFetch = (input, init) => {
  if (typeof globalThis.fetch !== 'function') throw new Error('Fetch API unavailable.');
  return globalThis.fetch(input, init);
};
const SECRET_KEY = /^(authorization|access_?token|refresh_?token|id_?token|token|secret|password|sms_?code|verification_?code|apikey|api_key|anonkey|service_role|credential|phone|email|recipient|body|payload)$/i;
const SENSITIVE_TEXT = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /Basic\s+[A-Za-z0-9+/=]+/gi,
  /\b(?:AC|VA)[0-9a-f]{32}\b/gi,
  /\bRZ[A-Z]-[A-F0-9]{16,}\b/gi,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /(?:\+?40|0)7\d{8}\b/g,
];

function redactText(value) {
  let text = String(value || '').slice(0, 1000);
  for (const pattern of SENSITIVE_TEXT) text = text.replace(pattern, '[REDACTED]');
  return text;
}

function safeValue(value, key = '', depth = 0) {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (depth > 3) return '[TRUNCATED]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 10).map(item => safeValue(item, '', depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 30).map(([childKey, child]) => [childKey, safeValue(child, childKey, depth + 1)]));
  }
  return redactText(value);
}

function serviceFor(url) {
  const host = url.hostname.toLowerCase();
  if (host.includes('supabase')) return 'supabase';
  if (host.includes('google')) return 'google';
  if (host.includes('revenuecat')) return 'revenuecat';
  return host || 'network';
}

function requestId(response) {
  return response.headers.get('x-request-id') || response.headers.get('sb-request-id') || response.headers.get('cf-ray') || null;
}

async function safeFailure(response) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('json')) return null;
  try {
    return safeValue(await response.clone().json());
  } catch {
    return null;
  }
}

/** Writes one-line JSON so Capacitor/Android Logcat never collapses an object to "[object Object]". */
export function externalApiLog(level, service, operation, details = {}) {
  const entry = {
    tag: 'RezervariExternalAPI',
    time: new Date().toISOString(),
    level,
    service,
    operation,
    ...safeValue(details),
  };
  const line = `[RezervariExternalAPI] ${JSON.stringify(entry)}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  // Diagnostic info is intentionally visible in Android Logcat.
  // eslint-disable-next-line no-console
  else console.info(line);
}

export function serializeExternalError(error) {
  if (error instanceof Error) {
    const source = /** @type {Error & Record<string, unknown>} */ (error);
    return safeValue({
      name: source.name,
      message: source.message,
      code: source.code,
      status: source.status,
      underlyingErrorMessage: source.underlyingErrorMessage,
      readableErrorCode: source.readableErrorCode,
      userCancelled: source.userCancelled,
    });
  }
  return safeValue(error);
}

/** Fetch implementation supplied to Supabase JS; it logs every Supabase HTTP connection. */
export async function loggedFetch(input, init = {}) {
  const started = performance.now();
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const service = serviceFor(url);
  const operation = `${method} ${url.pathname}`;
  externalApiLog('info', service, operation, { phase: 'start' });
  try {
    const response = await nativeFetch(input, init);
    const common = {
      phase: response.ok ? 'success' : 'failure',
      httpStatus: response.status,
      durationMs: Math.round(performance.now() - started),
      requestId: requestId(response),
    };
    if (response.ok) externalApiLog('info', service, operation, common);
    else externalApiLog('error', service, operation, { ...common, response: await safeFailure(response) });
    return response;
  } catch (error) {
    externalApiLog('error', service, operation, {
      phase: 'network-error',
      durationMs: Math.round(performance.now() - started),
      error: serializeExternalError(error),
    });
    throw error;
  }
}

export async function loggedExternalCall(service, operation, callback) {
  const started = performance.now();
  externalApiLog('info', service, operation, { phase: 'start' });
  try {
    const result = await callback();
    externalApiLog('info', service, operation, { phase: 'success', durationMs: Math.round(performance.now() - started) });
    return result;
  } catch (error) {
    externalApiLog('error', service, operation, {
      phase: 'failure',
      durationMs: Math.round(performance.now() - started),
      error: serializeExternalError(error),
    });
    throw error;
  }
}
