import {
  Anchor,
  Button,
  Card,
  Container,
  Group,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { Form, Link, useRouteLoaderData } from "react-router";
import { and, eq, desc, sql } from "drizzle-orm";
import type { Route } from "./+types/home";
import type { loader as appLoader } from "./_app";
import { CsrfField } from "../auth/csrf-field";
import { db } from "../db/client";
import { recipes } from "../db/schema";
import { requireFlatMember } from "../auth/require";
import { buildTsQuery } from "../search";

export function meta(_: Route.MetaArgs) {
  return [
    { title: "cookbook" },
    { name: "description", content: "Recipe collection + shopping list planner" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const ctx = await requireFlatMember(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const tsq = buildTsQuery(q);

  if (tsq) {
    const rankExpr = sql<number>`ts_rank_cd(${recipes.searchVector}, to_tsquery('simple', ${tsq}))`;
    const rows = await db()
      .select({
        id: recipes.id,
        name: recipes.name,
        baseQuantity: recipes.baseQuantity,
        updatedAt: recipes.updatedAt,
      })
      .from(recipes)
      .where(
        and(
          eq(recipes.flatId, ctx.flat.id),
          sql`${recipes.searchVector} @@ to_tsquery('simple', ${tsq})`,
        ),
      )
      .orderBy(desc(rankExpr), desc(recipes.updatedAt));
    return { recipes: rows, q };
  }

  const list = await db()
    .select({
      id: recipes.id,
      name: recipes.name,
      baseQuantity: recipes.baseQuantity,
      updatedAt: recipes.updatedAt,
    })
    .from(recipes)
    .where(eq(recipes.flatId, ctx.flat.id))
    .orderBy(desc(recipes.updatedAt));
  return { recipes: list, q: "" };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const data = useRouteLoaderData("routes/_app") as
    | Awaited<ReturnType<typeof appLoader>>
    | undefined;
  const { recipes: list, q } = loaderData;

  return (
    <Container size="sm" py="xl">
      <Stack gap="md">
        <Group justify="space-between" align="center">
          <Title order={1}>cookbook</Title>
          {data && (
            <Group gap="xs">
              <Anchor href="/kitchen" size="sm">
                Kitchen
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

        <Form method="get" role="search">
          <TextInput
            name="q"
            type="search"
            defaultValue={q}
            placeholder="Search recipes…"
            aria-label="Search recipes"
          />
        </Form>

        {list.length === 0 ? (
          <Text c="dimmed">{q ? `No recipes match "${q}"` : "No recipes yet"}</Text>
        ) : (
          <Stack gap="xs">
            {list.map((r) => (
              <Card
                key={r.id}
                withBorder
                padding="sm"
                component={Link}
                to={`/recipes/${r.id}`}
              >
                <Text fw={500}>{r.name}</Text>
                <Text size="sm" c="dimmed">
                  Base: {r.baseQuantity} portions
                </Text>
              </Card>
            ))}
          </Stack>
        )}

        <Group>
          <Button component={Link} to="/recipes/new" variant="default">
            + New recipe
          </Button>
        </Group>
      </Stack>
    </Container>
  );
}

