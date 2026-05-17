import { Button, Card, Group, Stack, Text, TextInput } from "@mantine/core";
import { Form, Link } from "react-router";
import type { Route } from "./+types/home";
import { requireFlatMember } from "../auth/require";
import { searchRecipes } from "../lib/recipes";

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

  const list = await searchRecipes({ flatId: ctx.flat.id, query: q });
  return { recipes: list, q };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { recipes: list, q } = loaderData;

  return (
    <Stack gap="md">
      <Form method="get" role="search">
        <Group gap="sm" wrap="nowrap" align="stretch">
          <TextInput
            name="q"
            type="search"
            defaultValue={q}
            placeholder="Search recipes…"
            aria-label="Search recipes"
            style={{ flex: 1 }}
          />
          <Button component={Link} to="/recipes/new" variant="default">
            + New recipe
          </Button>
        </Group>
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
    </Stack>
  );
}
