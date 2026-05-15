import {
  ActionIcon,
  Alert,
  Anchor,
  Button,
  Container,
  Group,
  NumberInput,
  Stack,
  TextInput,
  Textarea,
  Title,
} from "@mantine/core";
import { useState } from "react";
import { Form, redirect, useActionData } from "react-router";
import type { Route } from "./+types/recipes.new";
import { db } from "../db/client";
import { ingredients, recipes } from "../db/schema";
import { requireFlatMember } from "../auth/require";
import { requireCsrf } from "../auth/csrf";
import { CsrfField } from "../auth/csrf-field";
import { isSameOrigin } from "../auth/origin";

export async function loader({ request }: Route.LoaderArgs) {
  const ctx = await requireFlatMember(request);
  return { sessionId: ctx.session.id };
}

type ParsedIngredient = {
  position: number;
  amount: string | null;
  unit: string | null;
  item: string;
};

function parseIngredients(form: FormData): ParsedIngredient[] {
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

export async function action({ request }: Route.ActionArgs) {
  if (!isSameOrigin(request)) {
    throw new Response("Bad origin.", { status: 403 });
  }
  const ctx = await requireFlatMember(request);
  await requireCsrf(request, ctx.session.id);

  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim();
  const baseQuantityRaw = String(form.get("baseQuantity") ?? "").trim();
  const baseQuantityUnit = String(form.get("baseQuantityUnit") ?? "").trim();
  const sourceUrl = String(form.get("sourceUrl") ?? "").trim();
  const steps = String(form.get("steps") ?? "");
  const parsed = parseIngredients(form);

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

  if (errors.length > 0) return { error: errors.join(" ") };

  const recipeId = await db().transaction(async (tx) => {
    const [row] = await tx
      .insert(recipes)
      .values({
        flatId: ctx.flat.id,
        name,
        baseQuantity,
        baseQuantityUnit,
        sourceUrl: sourceUrl || null,
        sourceHost,
        steps,
      })
      .returning({ id: recipes.id });
    if (parsed.length > 0) {
      await tx.insert(ingredients).values(
        parsed.map((p) => ({
          recipeId: row.id,
          position: p.position,
          amount: p.amount,
          unit: p.unit,
          item: p.item,
        })),
      );
    }
    return row.id;
  });

  return redirect(`/recipes/${recipeId}`);
}

type Row = { amount: string; unit: string; item: string };
const blankRow = (): Row => ({ amount: "", unit: "", item: "" });

export default function NewRecipe({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<{ error?: string } | undefined>();
  const [rows, setRows] = useState<Row[]>([blankRow(), blankRow(), blankRow()]);

  const setRow = (i: number, patch: Partial<Row>) => {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };
  const removeRow = (i: number) => {
    setRows((rs) => (rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs));
  };
  const addRow = () => setRows((rs) => [...rs, blankRow()]);

  return (
    <Container size="sm" py="xl">
      <Stack gap="md">
        <Group justify="space-between" align="center">
          <Title order={2}>New recipe</Title>
          <Anchor href="/">← Cancel</Anchor>
        </Group>

        <Form method="post">
          <CsrfField sessionId={loaderData.sessionId} />
          <Stack gap="sm">
            <TextInput name="name" label="Name" required />

            <Group grow>
              <NumberInput
                name="baseQuantity"
                label="Base quantity"
                min={1}
                defaultValue={4}
                required
                allowDecimal={false}
              />
              <TextInput
                name="baseQuantityUnit"
                label="Base unit"
                placeholder="servings"
                defaultValue="servings"
                required
              />
            </Group>

            <TextInput
              name="sourceUrl"
              label="Source URL"
              type="url"
              placeholder="https://…"
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
            />

            {actionData?.error && (
              <Alert color="red" role="alert">
                {actionData.error}
              </Alert>
            )}

            <Group justify="flex-end">
              <Button type="submit">Save recipe</Button>
            </Group>
          </Stack>
        </Form>
      </Stack>
    </Container>
  );
}
