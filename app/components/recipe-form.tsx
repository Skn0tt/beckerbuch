import {
  ActionIcon,
  Alert,
  Button,
  Group,
  NumberInput,
  Stack,
  TextInput,
  Textarea,
  Title,
} from "@mantine/core";
import { useState } from "react";
import { Form } from "react-router";
import { CsrfField } from "../auth/csrf-field";

export type IngredientRow = { amount: string; unit: string; item: string };

export type RecipeFormInitial = {
  name?: string;
  baseQuantity?: number;
  baseQuantityUnit?: string;
  sourceUrl?: string;
  steps?: string;
  ingredients?: IngredientRow[];
};

const blankRow = (): IngredientRow => ({ amount: "", unit: "", item: "" });

type Props = {
  sessionId: string;
  initial?: RecipeFormInitial;
  error?: string;
  submitLabel: string;
};

export function RecipeForm({ sessionId, initial, error, submitLabel }: Props) {
  const initialRows =
    initial?.ingredients && initial.ingredients.length > 0
      ? initial.ingredients
      : [blankRow(), blankRow(), blankRow()];
  const [rows, setRows] = useState<IngredientRow[]>(initialRows);

  const setRow = (i: number, patch: Partial<IngredientRow>) => {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };
  const removeRow = (i: number) => {
    setRows((rs) => (rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs));
  };
  const addRow = () => setRows((rs) => [...rs, blankRow()]);

  return (
    <Form method="post">
      <CsrfField sessionId={sessionId} />
      <Stack gap="sm">
        <TextInput
          name="name"
          label="Name"
          required
          defaultValue={initial?.name ?? ""}
        />

        <Group grow>
          <NumberInput
            name="baseQuantity"
            label="Base quantity"
            min={1}
            defaultValue={initial?.baseQuantity ?? 4}
            required
            allowDecimal={false}
          />
          <TextInput
            name="baseQuantityUnit"
            label="Base unit"
            placeholder="servings"
            defaultValue={initial?.baseQuantityUnit ?? "servings"}
            required
          />
        </Group>

        <TextInput
          name="sourceUrl"
          label="Source URL"
          type="url"
          placeholder="https://…"
          defaultValue={initial?.sourceUrl ?? ""}
        />

        <Stack gap={4}>
          <Title order={5}>Ingredients</Title>
          {rows.map((row, i) => (
            <Group key={i} gap="xs" wrap="nowrap" align="end">
              <TextInput
                aria-label={`Ingredient ${i + 1} amount`}
                name="ingredient_amount"
                value={row.amount}
                onChange={(e) => setRow(i, { amount: e.currentTarget.value })}
                placeholder="amt"
                style={{ width: 80 }}
              />
              <TextInput
                aria-label={`Ingredient ${i + 1} unit`}
                name="ingredient_unit"
                value={row.unit}
                onChange={(e) => setRow(i, { unit: e.currentTarget.value })}
                placeholder="unit"
                style={{ width: 100 }}
              />
              <TextInput
                aria-label={`Ingredient ${i + 1} item`}
                name="ingredient_item"
                value={row.item}
                onChange={(e) => setRow(i, { item: e.currentTarget.value })}
                placeholder="item"
                style={{ flex: 1 }}
              />
              <ActionIcon
                variant="subtle"
                aria-label={`Remove ingredient ${i + 1}`}
                onClick={() => removeRow(i)}
                type="button"
              >
                ✕
              </ActionIcon>
            </Group>
          ))}
          <Button
            type="button"
            variant="default"
            size="xs"
            onClick={addRow}
            style={{ alignSelf: "flex-start" }}
          >
            + Add ingredient
          </Button>
        </Stack>

        <Textarea
          name="steps"
          label="Steps"
          autosize
          minRows={4}
          placeholder="1. …"
          defaultValue={initial?.steps ?? ""}
        />

        {error && (
          <Alert color="red" role="alert">
            {error}
          </Alert>
        )}

        <Group justify="flex-end">
          <Button type="submit">{submitLabel}</Button>
        </Group>
      </Stack>
    </Form>
  );
}

export type ParsedIngredient = {
  position: number;
  amount: string | null;
  unit: string | null;
  item: string;
};

export function parseIngredientsFromForm(form: FormData): ParsedIngredient[] {
  const items = form.getAll("ingredient_item").map((x) => String(x));
  const amounts = form.getAll("ingredient_amount").map((x) => String(x));
  const units = form.getAll("ingredient_unit").map((x) => String(x));
  const out: ParsedIngredient[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = (items[i] ?? "").trim();
    if (!item) continue;
    const amountRaw = (amounts[i] ?? "").trim();
    const unitRaw = (units[i] ?? "").trim();
    out.push({
      position: out.length,
      amount: amountRaw || null,
      unit: unitRaw || null,
      item,
    });
  }
  return out;
}

export type RecipeFields = {
  name: string;
  baseQuantity: number;
  baseQuantityUnit: string;
  sourceUrl: string | null;
  sourceHost: string | null;
  steps: string;
};

export type ParseResult =
  | { ok: true; fields: RecipeFields; ingredients: ParsedIngredient[] }
  | { ok: false; error: string };

export function parseRecipeFields(form: FormData): ParseResult {
  const name = String(form.get("name") ?? "").trim();
  const baseQuantityRaw = String(form.get("baseQuantity") ?? "").trim();
  const baseQuantityUnit = String(form.get("baseQuantityUnit") ?? "").trim();
  const sourceUrl = String(form.get("sourceUrl") ?? "").trim();
  const steps = String(form.get("steps") ?? "");
  const parsed = parseIngredientsFromForm(form);

  const errors: string[] = [];
  if (!name || name.length > 200) errors.push("Name is required (max 200 chars).");
  const baseQuantity = Number.parseInt(baseQuantityRaw, 10);
  if (!Number.isFinite(baseQuantity) || baseQuantity <= 0) {
    errors.push("Base quantity must be a positive integer.");
  }
  if (!baseQuantityUnit) errors.push("Base unit is required (e.g. 'servings').");
  if (parsed.length === 0) errors.push("Add at least one ingredient.");

  let sourceHost: string | null = null;
  if (sourceUrl) {
    try {
      sourceHost = new URL(sourceUrl).host;
    } catch {
      errors.push("Source URL is not a valid URL.");
    }
  }

  if (errors.length > 0) return { ok: false, error: errors.join(" ") };
  return {
    ok: true,
    fields: {
      name,
      baseQuantity,
      baseQuantityUnit,
      sourceUrl: sourceUrl || null,
      sourceHost,
      steps,
    },
    ingredients: parsed,
  };
}
