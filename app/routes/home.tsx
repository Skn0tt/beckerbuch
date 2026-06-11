import { Box, Button, Group, NavLink as MantineNavLink, Stack, Text, TextInput } from "@mantine/core";
import { Form, Link, useLoaderData } from "react-router";
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

export default function Home() {
  const { recipes: list, q } = useLoaderData<typeof loader>();

  return (
    <Stack
      gap="md"
      style={{
        height:
          "calc(100dvh - var(--app-shell-header-height, 56px) - var(--app-shell-footer-offset, 0px) - 2 * var(--mantine-spacing-md))",
      }}
    >
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
          <Button component={Link} to="/recipes/new" prefetch="intent" variant="default">
            + New recipe
          </Button>
        </Group>
      </Form>

      {list.length === 0 ? (
        <Text c="dimmed">{q ? `No recipes match "${q}"` : "No recipes yet"}</Text>
      ) : (
        <Box style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {list.map((r) => (
            <MantineNavLink
              key={r.id}
              component={Link}
              to={`/recipes/${r.id}`}
              prefetch="intent"
              label={r.name}
            />
          ))}
        </Box>
      )}
    </Stack>
  );
}
