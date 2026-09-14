import { fmtDateTime } from './time.js';

export const helpers = {
  money: (n, digits = 2) => (Number.isFinite(Number(n)) ? Number(n).toFixed(digits) : '0.00'),
  num: (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString('en-US') : '0'),
  pct: (n) => (Number.isFinite(n) ? (n * 100).toFixed(2) + '%' : '-'),
  dt: fmtDateTime,
  trunc: (s, n = 40) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || ''),
  qs: (base, params) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, v);
    const s = u.toString();
    return s ? `${base}?${s}` : base;
  },
};
