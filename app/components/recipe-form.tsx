import {
  ActionIcon,
  Alert,
  Button,
  Checkbox,
  FileInput,
  Group,
  Image,
  NumberInput,
  Stack,
  Table,
  TextInput,
  Textarea,
  Title,
} from "@mantine/core";
import { useState, type ReactNode } from "react";
import { Form, useNavigation } from "react-router";
import { CsrfField } from "../auth/csrf-field";

export type IngredientRow = { amount: string; unit: string; item: string };

const visuallyHidden = {
  position: "absolute" as const,
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap" as const,
  border: 0,
};

export type RecipeFormInitial = {
  name?: string;
  baseQuantity?: number;
  sourceUrl?: string;
  steps?: string;
  ingredients?: IngredientRow[];
  photoUrl?: string | null;
};

const blankRow = (): IngredientRow => ({ amount: "", unit: "", item: "" });
const isBlankRow = (row: IngredientRow | undefined) => {
  if (!row) return false;
  return row.amount.trim() === "" && row.unit.trim() === "" && row.item.trim() === "";
};
const ensureTrailingBlankRow = (rows: IngredientRow[]) => {
  const normalized = [...rows];
  while (normalized.length > 1) {
    const last = normalized.at(-1);
    const previous = normalized.at(-2);
    if (!isBlankRow(last) || !isBlankRow(previous)) break;
    normalized.pop();
  }
  if (normalized.length === 0 || !isBlankRow(normalized.at(-1))) {
    normalized.push(blankRow());
  }
  return normalized;
};

type Props = {
  csrfToken: string;
  initial?: RecipeFormInitial;
  error?: string;
  submitLabel: string;
  secondaryAction?: ReactNode;
  hiddenExtras?: ReactNode;
};

export function RecipeForm({
  csrfToken,
  initial,
  error,
  submitLabel,
  secondaryAction,
  hiddenExtras,
}: Props) {
  const initialRows =
    initial?.ingredients && initial.ingredients.length > 0
      ? initial.ingredients
      : [blankRow()];
  const [rows, setRows] = useState<IngredientRow[]>(ensureTrailingBlankRow(initialRows));
  const navigation = useNavigation();
  // Prevents double-submit (rapid second click, mobile double-tap, repeated
  // Enter) creating duplicate recipes. Mantine's `loading` doesn't set the
  // underlying DOM `disabled`, so set both.
  const isSubmitting = navigation.state !== "idle";

  const setRow = (i: number, patch: Partial<IngredientRow>) => {
    setRows((rs) =>
      ensureTrailingBlankRow(rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r))),
    );
  };
  const removeRow = (i: number) => {
    setRows((rs) => ensureTrailingBlankRow(rs.filter((_, idx) => idx !== i)));
  };

  return (
    <Form method="post" encType="multipart/form-data">
      <CsrfField token={csrfToken} />
      {hiddenExtras}
      <Stack gap="sm">
        <TextInput
          name="name"
          label="Name"
          required
          defaultValue={initial?.name ?? ""}
        />

        <NumberInput
          name="baseQuantity"
          label="Base portions"
          min={1}
          defaultValue={initial?.baseQuantity ?? 4}
          required
          allowDecimal={false}
        />

        <TextInput
          name="sourceUrl"
          label="Source URL"
          type="url"
          placeholder="https://…"
          defaultValue={initial?.sourceUrl ?? ""}
        />

        <Stack gap="xs">
          {initial?.photoUrl && (
            <Stack gap={4}>
              <Image
                src={initial.photoUrl}
                alt="Current photo"
                radius="sm"
                fit="cover"
                h={160}
                w="auto"
              />
              <Checkbox
                name="removePhoto"
                value="1"
                label="Remove current photo"
              />
            </Stack>
          )}
          <FileInput
            name="photo"
            label={initial?.photoUrl ? "Replace photo" : "Photo"}
            accept="image/jpeg,image/png,image/webp"
            placeholder="Choose an image…"
            clearable
          />
        </Stack>

        <Stack gap={4}>
          <Title order={5}>Ingredients</Title>
          <Table aria-label="Ingredients" verticalSpacing={4} horizontalSpacing={4} withRowBorders={false}>
            <colgroup>
              <col style={{ width: 80 }} />
              <col style={{ width: 100 }} />
              <col />
              <col style={{ width: 32 }} />
            </colgroup>
            <Table.Thead style={visuallyHidden}>
              <Table.Tr>
                <Table.Th>Amount</Table.Th>
                <Table.Th>Unit</Table.Th>
                <Table.Th>Item</Table.Th>
                <Table.Th>Actions</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((row, i) => (
                <Table.Tr key={i} aria-label={`Ingredient ${i + 1}`}>
                  <Table.Td>
                    <TextInput
                      aria-label="Amount"
                      name="ingredient_amount"
                      value={row.amount}
                      onChange={(e) => setRow(i, { amount: e.currentTarget.value })}
                      placeholder="amt"
                    />
                  </Table.Td>
                  <Table.Td>
                    <TextInput
                      aria-label="Unit"
                      name="ingredient_unit"
                      value={row.unit}
                      onChange={(e) => setRow(i, { unit: e.currentTarget.value })}
                      placeholder="unit"
                      autoCapitalize="none"
                      autoCorrect="off"
                    />
                  </Table.Td>
                  <Table.Td>
                    <TextInput
                      aria-label="Item"
                      name="ingredient_item"
                      value={row.item}
                      onChange={(e) => setRow(i, { item: e.currentTarget.value })}
                      placeholder="item"
                    />
                  </Table.Td>
                  <Table.Td>
                    <ActionIcon
                      variant="subtle"
                      aria-label="Remove"
                      onClick={() => removeRow(i)}
                      type="button"
                    >
                      ✕
                    </ActionIcon>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
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

        <Group justify="space-between">
          {secondaryAction ?? <span />}
          <Button type="submit" loading={isSubmitting} disabled={isSubmitting}>
            {submitLabel}
          </Button>
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
  const sourceUrl = String(form.get("sourceUrl") ?? "").trim();
  const steps = String(form.get("steps") ?? "");
  const parsed = parseIngredientsFromForm(form);

  const errors: string[] = [];
  if (!name || name.length > 200) errors.push("Name is required (max 200 chars).");
  const baseQuantity = Number.parseInt(baseQuantityRaw, 10);
  if (!Number.isFinite(baseQuantity) || baseQuantity < 1 || baseQuantity > 1000) {
    errors.push("Base portions must be between 1 and 1000.");
  }
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
      sourceUrl: sourceUrl || null,
      sourceHost,
      steps,
    },
    ingredients: parsed,
  };
}
