// @ts-check

let activeInteractions = 0;
let ignoreBackUntil = 0;

/** Keep Android's back callback from navigating the WebView while native UI closes. */
export function beginNativeInteraction() {
  activeInteractions += 1;
}

export function endNativeInteraction() {
  activeInteractions = Math.max(0, activeInteractions - 1);
  ignoreBackUntil = Date.now() + 1500;
}

export function shouldIgnoreNativeBack() {
  return activeInteractions > 0 || Date.now() < ignoreBackUntil;
}
