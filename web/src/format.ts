// Display helpers shared by the UI modules. Pure functions; no DOM.
export const money = (n: number, digits = 2): string =>
  Number(n).toLocaleString('en-US', {style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits});
export const signed = (n: number): string => `${n >= 0 ? '+' : '−'}${money(Math.abs(n))}`;
export const pct = (n: number): string => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}%`;
export const utc = (ms: number | null | undefined): string =>
  ms == null || !Number.isFinite(ms) ? '—' : new Date(ms).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
export const shortTime = (ms: number): string => new Date(ms).toISOString().slice(11, 19);
/** Saved-at timestamps arrive as ISO strings. */
export const utcIso = (iso: string | null | undefined): string => (iso ? utc(Date.parse(iso)) : '—');
export const digitsFor = (asset: string): number => (asset === 'BTC' ? 2 : 4);
export const qtyDigits = (asset: string): number => (asset === 'BTC' ? 6 : 3);

/** Tiny DOM helper: element with class and text (text is always set via textContent). */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
