import {
  ActionIcon,
  Alert,
  Anchor,
  Box,
  Button,
  Group,
  Image,
  List,
  Modal,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { and, eq, asc, isNotNull, isNull, max, sql } from "drizzle-orm";
import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useFetcher,
  useFetchers,
} from "react-router";
import { z } from "zod";
import type { Route } from "./+types/recipes.$id";
import { db } from "../db/client";
import { ingredients, recipeInstances, recipes } from "../db/schema";
import { requireFlatMember } from "../auth/require";
import { requireCsrf, csrfTokenForSession } from "../auth/csrf.server";
import { CsrfField } from "../auth/csrf-field";
import { csrfFieldName } from "../auth/csrf-shared";
import { isSameOrigin } from "../auth/origin";
import { deletePhoto } from "../blobs";
import { formatIngredient } from "../lib/scale";
import { firstMessage, formDataToObject, parseParams } from "../lib/form";

const ParamsSchema = z.object({ id: z.guid() });

const ActionSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("add-to-draft") }),
  z.object({
    intent: z.literal("update-quantity"),
    targetQuantity: z.coerce
      .number({ message: "Portions must be between 1 and 1000." })
      .int("Portions must be between 1 and 1000.")
      .min(1, "Portions must be between 1 and 1000.")
      .max(1000, "Portions must be between 1 and 1000."),
  }),
  z.object({ intent: z.literal("mark-cooked") }),
  z.object({ intent: z.literal("delete") }),
]);

export async function loader({ request, params }: Route.LoaderArgs) {
  const ctx = await requireFlatMember(request);
  const { id } = parseParams(ParamsSchema, params, "Recipe not found.");
  const [recipe] = await db()
    .select()
    .from(recipes)
    .where(eq(recipes.id, id))
    .limit(1);
  if (!recipe || recipe.flatId !== ctx.flat.id) {
    throw data("Recipe not found.", { status: 404 });
  }
  const [ings, draftInstance, stockInstance] = await Promise.all([
    db()
      .select()
      .from(ingredients)
      .where(eq(ingredients.recipeId, recipe.id))
      .orderBy(asc(ingredients.position)),
    // Show "In draft" state if this recipe already has an open draft
    // instance for the flat. We pick the lowest-position one as the
    // target for quantity updates (legacy data may have multiple).
    db()
      .select({
        id: recipeInstances.id,
        targetQuantity: recipeInstances.targetQuantity,
      })
      .from(recipeInstances)
      .where(
        and(
          eq(recipeInstances.flatId, ctx.flat.id),
          eq(recipeInstances.recipeId, recipe.id),
          isNull(recipeInstances.finalisedAt),
        ),
      )
      .orderBy(asc(recipeInstances.position))
      .limit(1)
      .then((r) => r[0] ?? null),
    db()
      .select({
        id: recipeInstances.id,
        targetQuantity: recipeInstances.targetQuantity,
      })
      .from(recipeInstances)
      .where(
        and(
          eq(recipeInstances.flatId, ctx.flat.id),
          eq(recipeInstances.recipeId, recipe.id),
          isNotNull(recipeInstances.finalisedAt),
          isNull(recipeInstances.cookedAt),
        ),
      )
      .orderBy(asc(recipeInstances.position))
      .limit(1)
      .then((r) => r[0] ?? null),
  ]);
  return {
    recipe,
    ingredients: ings,
    draftInstance,
    stockInstance,
    csrfToken: csrfTokenForSession(ctx.session.id),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  if (!isSameOrigin(request)) {
    throw new Response("Bad origin.", { status: 403 });
  }
  const ctx = await requireFlatMember(request);
  const { id } = parseParams(ParamsSchema, params, "Recipe not found.");
  const [recipe] = await db()
    .select()
    .from(recipes)
    .where(eq(recipes.id, id))
    .limit(1);
  if (!recipe || recipe.flatId !== ctx.flat.id) {
    throw data("Recipe not found.", { status: 404 });
  }

  await requireCsrf(request, ctx.session.id);
  const form = await request.formData();
  const parsed = ActionSchema.safeParse(formDataToObject(form));
  if (!parsed.success) {
    return { error: firstMessage(parsed.error) };
  }

  if (parsed.data.intent === "add-to-draft") {
    const flatId = ctx.flat.id;
    // One draft instance per recipe — clicking add again is a no-op.
    const existing = await db()
      .select({ id: recipeInstances.id })
      .from(recipeInstances)
      .where(
        and(
          eq(recipeInstances.flatId, flatId),
          eq(recipeInstances.recipeId, recipe.id),
          isNull(recipeInstances.finalisedAt),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      return { added: true as const };
    }
    // Retry on partial-unique-index collision (concurrent add).
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const [{ value: nextPos }] = await db()
          .select({
            value: sql<number>`coalesce(${max(recipeInstances.position)}, -1) + 1`,
          })
          .from(recipeInstances)
          .where(
            and(
              eq(recipeInstances.flatId, flatId),
              isNull(recipeInstances.finalisedAt),
            ),
          );
        await db().insert(recipeInstances).values({
          flatId,
          recipeId: recipe.id,
          targetQuantity: recipe.baseQuantity,
          position: nextPos,
        });
        return { added: true as const };
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === "23505" && attempt < 2) continue; // unique_violation, retry
        throw err;
      }
    }
    return { error: "Couldn't add to draft. Please try again." };
  }

  if (parsed.data.intent === "update-quantity") {
    await db()
      .update(recipeInstances)
      .set({ targetQuantity: parsed.data.targetQuantity })
      .where(
        and(
          eq(recipeInstances.flatId, ctx.flat.id),
          eq(recipeInstances.recipeId, recipe.id),
          isNull(recipeInstances.finalisedAt),
        ),
      );
    return { ok: true as const };
  }

  if (parsed.data.intent === "mark-cooked") {
    const updated = await db()
      .update(recipeInstances)
      .set({ cookedAt: new Date(), cookedBy: ctx.user.id })
      .where(
        and(
          eq(recipeInstances.flatId, ctx.flat.id),
          eq(recipeInstances.recipeId, recipe.id),
          isNotNull(recipeInstances.finalisedAt),
          isNull(recipeInstances.cookedAt),
        ),
      )
      .returning({ id: recipeInstances.id });
    if (updated.length === 0) {
      return { error: "Already cooked or not in stock." };
    }
    return { ok: true as const };
  }

  // delete
  // Single round-trip: delete only if no recipeInstances reference it.
  // Returning rows lets us tell "didn't exist" from "blocked by usage".
  const deleted = await db()
    .delete(recipes)
    .where(
      and(
        eq(recipes.id, recipe.id),
        sql`not exists (select 1 from ${recipeInstances} where ${recipeInstances.recipeId} = ${recipes.id})`,
      ),
    )
    .returning({ id: recipes.id });
  if (deleted.length === 0) {
    return {
      error:
        "This recipe is in your draft, in stock, or cooked history — remove it from there before deleting.",
    };
  }
  if (recipe.photoBlobKey) await deletePhoto(recipe.photoBlobKey);
  return redirect("/");
}

function DraftControls({
  recipeName,
  targetQuantity,
  csrfToken,
}: {
  recipeName: string;
  targetQuantity: number;
  csrfToken: string;
}) {
  const qtyFetcher = useFetcher();
  const current = targetQuantity;

  const submitTarget = (next: number) => {
    if (next < 1 || next > 1000) return;
    const fd = new FormData();
    fd.set("intent", "update-quantity");
    fd.set("targetQuantity", String(next));
    fd.set(csrfFieldName(), csrfToken);
    qtyFetcher.submit(fd, { method: "post" });
  };

  return (
    <Group gap="sm" wrap="nowrap" align="center">
      <Button variant="default" color="gray" disabled>
        ✓ In draft
      </Button>
      {/* Steppers only on mobile — desktop users have the kitchen sidebar. */}
      <Group gap={4} wrap="nowrap" hiddenFrom="md">
        <ActionIcon
          variant="default"
          size="md"
          type="button"
          aria-label={`Decrease ${recipeName} portions`}
          onClick={() => submitTarget(Math.max(1, current - 1))}
          disabled={current <= 1}
        >
          −
        </ActionIcon>
        <Text size="sm" w={28} ta="center" aria-live="polite">
          {current}
        </Text>
        <ActionIcon
          variant="default"
          size="md"
          type="button"
          aria-label={`Increase ${recipeName} portions`}
          onClick={() => submitTarget(current + 1)}
          disabled={current >= 1000}
        >
          +
        </ActionIcon>
        <Text size="sm" c="dimmed">
          portions
        </Text>
      </Group>
    </Group>
  );
}

function CookedButton({
  recipeName,
  csrfToken,
}: {
  recipeName: string;
  csrfToken: string;
}) {
  const [opened, { open, close }] = useDisclosure(false);
  return (
    <>
      <Button variant="outline" color="green" onClick={open}>
        Mark as cooked
      </Button>
      <Modal opened={opened} onClose={close} title="Mark as cooked?" size="sm">
        <Stack gap="sm">
          <Text size="sm">
            Mark <strong>{recipeName}</strong> as cooked? This removes it from
            In stock.
          </Text>
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={close}>
              Cancel
            </Button>
            <Form method="post" onSubmit={close}>
              <CsrfField token={csrfToken} />
              <input type="hidden" name="intent" value="mark-cooked" />
              <Button
                type="submit"
                color="green"
                aria-label={`Confirm mark ${recipeName} as cooked`}
              >
                ✓ Cooked
              </Button>
            </Form>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

export default function RecipeView({ loaderData }: Route.ComponentProps) {
  const { recipe, ingredients: ings, draftInstance, stockInstance, csrfToken } =
    loaderData;
  const actionData = useActionData<{ error?: string } | undefined>();
  // Add-to-draft uses a fetcher so the loader revalidates and the
  // button flips to the "In draft" state without a full navigation.
  const addFetcher = useFetcher<{ added?: true; error?: string }>();
  const fetchers = useFetchers();
  const addError = addFetcher.data?.error;
  const pendingTargets = fetchers
    .map((f) => f.formData)
    .map((fd) => {
      if (!fd) return null;
      if (fd.get("intent") !== "update-quantity") return null;
      const targetRaw = fd.get("targetQuantity");
      if (
        typeof targetRaw !== "string" ||
        !Number.isInteger(Number(targetRaw)) ||
        Number(targetRaw) < 1 ||
        Number(targetRaw) > 1000
      ) {
        return null;
      }
      const instanceIdRaw = fd.get("instanceId");
      if (
        draftInstance &&
        typeof instanceIdRaw === "string" &&
        instanceIdRaw !== draftInstance.id
      ) {
        return null;
      }
      return Number(targetRaw);
    });
  const pendingDraftTarget =
    [...pendingTargets].reverse().find((n): n is number => n !== null) ?? null;
  const draftTargetQuantity = pendingDraftTarget ?? draftInstance?.targetQuantity;
  const scaledQuantity =
    stockInstance?.targetQuantity ??
    draftTargetQuantity ??
    recipe.baseQuantity;
  const factor = recipe.baseQuantity > 0 ? scaledQuantity / recipe.baseQuantity : 1;
  return (
    <Stack gap="md">
      {actionData?.error && (
        <Alert color="red" role="alert">
          {actionData.error}
        </Alert>
      )}
      {addError && (
        <Alert color="red" role="alert">
          {addError}
        </Alert>
      )}

      <Title order={1}>{recipe.name}</Title>

      {recipe.photoBlobKey && (
        <Image
          src={`/recipes/${recipe.id}/photo`}
          alt={recipe.name}
          radius="sm"
          fit="cover"
          mah={360}
        />
      )}

      <Text c="dimmed">Base: {recipe.baseQuantity} portions</Text>

      <Box>
        {stockInstance ? (
          <CookedButton recipeName={recipe.name} csrfToken={csrfToken} />
        ) : draftInstance ? (
          <DraftControls
            recipeName={recipe.name}
            targetQuantity={draftTargetQuantity ?? recipe.baseQuantity}
            csrfToken={csrfToken}
          />
        ) : (
          <addFetcher.Form method="post">
            <CsrfField token={csrfToken} />
            <input type="hidden" name="intent" value="add-to-draft" />
            <Button type="submit">+ Add to draft</Button>
          </addFetcher.Form>
        )}
      </Box>

      <section>
        <Title order={4} mb="xs">
          Ingredients ({scaledQuantity} portions)
        </Title>
        <List spacing={2}>
          {ings.map((i) => (
            <List.Item key={i.id}>{formatIngredient(i, factor)}</List.Item>
          ))}
        </List>
      </section>

      {recipe.steps.trim() && (
        <section>
          <Title order={4} mb="xs">
            Steps
          </Title>
          <Text style={{ whiteSpace: "pre-wrap" }}>{recipe.steps}</Text>
        </section>
      )}

      {recipe.sourceUrl && (
        <Text size="sm">
          Source:{" "}
          <Anchor href={recipe.sourceUrl} target="_blank" rel="noreferrer">
            {recipe.sourceHost ?? recipe.sourceUrl} ↗
          </Anchor>
        </Text>
      )}

      <Anchor component={Link} to={`/recipes/${recipe.id}/edit`} prefetch="intent">
        Edit recipe
      </Anchor>
    </Stack>
  );
}
