import {
  Anchor,
  Button,
  Card,
  Container,
  Group,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { and, asc, eq, isNull } from "drizzle-orm";
import { Form, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/kitchen";
import { db } from "../db/client";
import { recipeInstances, recipes } from "../db/schema";
import { requireFlatMember } from "../auth/require";
import { requireCsrf } from "../auth/csrf";
import { CsrfField } from "../auth/csrf-field";
import { isSameOrigin } from "../auth/origin";
import type { loader as appLoader } from "./_app";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loader({ request }: Route.LoaderArgs) {
  const ctx = await requireFlatMember(request);
  const draft = await db()
    .select({
      id: recipeInstances.id,
      targetQuantity: recipeInstances.targetQuantity,
      position: recipeInstances.position,
      recipeId: recipes.id,
      recipeName: recipes.name,
      baseQuantity: recipes.baseQuantity,
    })
    .from(recipeInstances)
    .innerJoin(recipes, eq(recipes.id, recipeInstances.recipeId))
    .where(
      and(
        eq(recipeInstances.flatId, ctx.flat.id),
        isNull(recipeInstances.finalisedAt),
      ),
    )
    .orderBy(asc(recipeInstances.position));
  return { draft, sessionId: ctx.session.id };
}

export async function action({ request }: Route.ActionArgs) {
  if (!isSameOrigin(request)) {
    throw new Response("Bad origin.", { status: 403 });
  }
  const ctx = await requireFlatMember(request);
  await requireCsrf(request, ctx.session.id);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const instanceId = String(form.get("instanceId") ?? "");

  if (intent === "remove-from-draft") {
    if (!UUID_RE.test(instanceId)) return { error: "Invalid instance." };
    await db()
      .delete(recipeInstances)
      .where(
        and(
          eq(recipeInstances.id, instanceId),
          eq(recipeInstances.flatId, ctx.flat.id),
          isNull(recipeInstances.finalisedAt),
        ),
      );
    return { ok: true };
  }

  return { error: "Unknown action." };
}

export default function Kitchen({ loaderData }: Route.ComponentProps) {
  const { draft, sessionId } = loaderData;
  const data = useRouteLoaderData("routes/_app") as
    | Awaited<ReturnType<typeof appLoader>>
    | undefined;
  return (
    <Container size="sm" py="xl">
      <Stack gap="md">
        <Group justify="space-between" align="center">
          <Title order={1}>Kitchen</Title>
          {data && (
            <Group gap="xs">
              <Anchor href="/" size="sm">
                Collection
              </Anchor>
              <Anchor href="/flat/settings" size="sm">
                Flat settings
              </Anchor>
              <Form method="post" action="/logout">
                <CsrfField sessionId={data.sessionId} />
                <Button type="submit" variant="subtle" size="xs">
                  Sign out {data.user.displayName}
                </Button>
              </Form>
            </Group>
          )}
        </Group>

        <Title order={3}>Draft ({draft.length})</Title>

        {draft.length === 0 ? (
          <Text c="dimmed">
            Draft is empty — add recipes from the{" "}
            <Anchor href="/">collection</Anchor>.
          </Text>
        ) : (
          <Stack gap="xs">
            {draft.map((d) => (
              <Card key={d.id} withBorder padding="sm">
                <Group justify="space-between" align="center">
                  <Stack gap={2}>
                    <Anchor href={`/recipes/${d.recipeId}`} fw={500}>
                      {d.recipeName}
                    </Anchor>
                    <Text size="sm" c="dimmed">
                      {d.targetQuantity} portions
                    </Text>
                  </Stack>
                  <Form method="post">
                    <CsrfField sessionId={sessionId} />
                    <input type="hidden" name="intent" value="remove-from-draft" />
                    <input type="hidden" name="instanceId" value={d.id} />
                    <Button
                      type="submit"
                      color="red"
                      variant="subtle"
                      size="xs"
                      aria-label={`Remove ${d.recipeName} from draft`}
                    >
                      Remove
                    </Button>
                  </Form>
                </Group>
              </Card>
            ))}
          </Stack>
        )}
      </Stack>
    </Container>
  );
}
