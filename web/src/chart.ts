// Equity chart as inline SVG: strategy vs buy-and-hold vs cash, every point of the account's equity
// series (no sampling), colours from CSS variables so it follows light/dark. Numbers the chart was
// drawn from are exposed as data-* attributes so tests can check the drawing against an oracle.
import type {EquityPoint} from './client.ts';
import {money, shortTime} from './format.ts';

const NS = 'http://www.w3.org/2000/svg';
const WIDTH = 700, HEIGHT = 215, LEFT = 49, RIGHT = 8, TOP = 14, BOTTOM = 29;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text?: string): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderEquityChart(host: HTMLElement, points: readonly EquityPoint[], initialCash: number): void {
  if (!points.length) {
    host.replaceChildren(Object.assign(document.createElement('p'), {className: 'chart-empty', textContent: 'Your account’s performance will appear here.'}));
    return;
  }
  const values = points.flatMap(p => [p.value, p.buyHoldValue, p.cashValue]);
  let lo = Math.min(...values), hi = Math.max(...values);
  const pad = Math.max((hi - lo) * 0.13, 1);
  lo -= pad;
  hi += pad;
  const first = points[0]!.time, last = points.at(-1)!;
  const x = (t: number): number => LEFT + (t - first) / Math.max(1, last.time - first) * (WIDTH - LEFT - RIGHT);
  const y = (v: number): number => TOP + (hi - v) / (hi - lo) * (HEIGHT - TOP - BOTTOM);
  const path = (pick: (p: EquityPoint) => number): string => points.map((p, i) => `${i ? 'L' : 'M'}${x(p.time).toFixed(2)},${y(pick(p)).toFixed(2)}`).join(' ');

  const root = svg('svg', {viewBox: `0 0 ${WIDTH} ${HEIGHT}`, role: 'img', id: 'chart-svg',
    'aria-label': `Paper account ${money(last.value)}, buy-and-hold ${money(last.buyHoldValue)}, cash ${money(initialCash)}`,
    'data-points': points.length, 'data-y-lo': lo, 'data-y-hi': hi, 'data-plot-top': TOP, 'data-plot-bottom': HEIGHT - BOTTOM, 'data-x-first': first, 'data-x-last': last.time});
  root.append(svg('title', {}, 'Net account value after modeled exit costs, buy-and-hold and cash'));
  for (let i = 0; i < 4; i++) {
    const value = lo + (hi - lo) * i / 3, py = y(value);
    root.append(svg('line', {x1: LEFT, y1: py, x2: WIDTH - RIGHT, y2: py, class: 'grid'}),
      svg('text', {x: LEFT - 9, y: py + 3, 'text-anchor': 'end', class: 'axis'}, money(value, 0)));
  }
  const series: [string, string, (p: EquityPoint) => number][] = [
    ['chart-cash', 'line-cash', p => p.cashValue], ['chart-buyhold', 'line-buyhold', p => p.buyHoldValue], ['chart-strategy', 'line-strategy', p => p.value]];
  for (const [id, cls, pick] of series) {
    root.append(svg('path', {id, class: cls, d: path(pick), fill: 'none', 'data-points': points.length, 'data-last': pick(last)}));
  }
  root.append(svg('circle', {cx: x(last.time), cy: y(last.value), r: 3.5, class: 'dot-strategy'}),
    svg('text', {x: LEFT, y: HEIGHT - 5, class: 'axis'}, `${shortTime(first)} UTC`),
    svg('text', {x: WIDTH - RIGHT, y: HEIGHT - 5, 'text-anchor': 'end', class: 'axis'}, `${shortTime(last.time)} UTC`));
  host.replaceChildren(root);
}
