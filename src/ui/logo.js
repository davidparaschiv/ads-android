// @ts-check

/** @param {'compact' | 'full'} [variant] */
export function logo(variant = 'full') {
  const word = variant === 'full' ? '<span class="brand-word">REZERVARI.AI</span>' : '';
  return `<button class="brand brand--home" type="button" data-home aria-label="Acasă Rezervari.ai">
    <svg class="brand-mark" viewBox="0 0 56 56" role="img" aria-hidden="true">
      <rect x="3" y="3" width="50" height="50" rx="16" fill="currentColor"/>
      <path d="M18 17h16c7 0 10 4 10 9 0 4-2 7-6 8l7 7H34l-6-7h-1v7h-9V17Zm9 8v4h7c2 0 3-1 3-2s-1-2-3-2h-7Z" fill="white"/>
      <path d="M13 11h7M36 45h7" stroke="white" stroke-width="2" stroke-linecap="round" opacity=".8"/>
    </svg>${word}
  </button>`;
}
