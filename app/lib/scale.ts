import { parseAmount } from "./amount";

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
  const n = parseAmount(amount);
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
