export type ScalableIngredient = {
  amount: string | null;
  unit: string | null;
  item: string;
};

export function scaleAmount(
  amount: string | null,
  factor: number,
): string | null {
  if (amount === null) return null;
  const trimmed = amount.trim();
  let n: number | null = null;
  const fracMatch = trimmed.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (fracMatch) {
    const a = Number(fracMatch[1]);
    const b = Number(fracMatch[2]);
    if (b !== 0) n = a / b;
  } else {
    const parsed = Number(trimmed.replace(",", "."));
    if (Number.isFinite(parsed)) n = parsed;
  }
  if (n === null) return amount;
  const scaled = n * factor;
  if (Number.isInteger(scaled)) return String(scaled);
  return Number(scaled.toFixed(2)).toString();
}

export function formatIngredient(
  ing: ScalableIngredient,
  factor: number,
): string {
  const parts: string[] = [];
  const scaled = scaleAmount(ing.amount, factor);
  if (scaled) parts.push(scaled);
  if (ing.unit) parts.push(ing.unit);
  parts.push(ing.item);
  return parts.join(" ");
}
