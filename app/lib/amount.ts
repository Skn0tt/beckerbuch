export function parseAmount(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  const frac = trimmed.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (frac) {
    const a = Number(frac[1]);
    const b = Number(frac[2]);
    return b === 0 ? null : a / b;
  }
  const n = Number(trimmed.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
