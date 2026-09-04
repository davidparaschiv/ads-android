// @ts-check

/**
 * Keeps application/domain validation messages, but never exposes unexpected
 * database, authentication, HTTP or provider diagnostics in the UI.
 * The original error remains available to the diagnostic/database loggers.
 * @param {unknown} error
 * @returns {string}
 */
export function errorMessageForUser(error) {
  const value=error&&typeof error==='object'?/** @type {Record<string,unknown>} */(error):{};
  const message=typeof value.message==='string'?value.message.trim():'';
  if(String(value.code||'')==='P0001'&&message)return message;
  if(error instanceof Error&&error.constructor===Error&&error.name==='Error'&&message)return message;
  return 'Error';
}
