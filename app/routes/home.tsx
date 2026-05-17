import {
  Box,
  Button,
  Card,
  Grid,
  Group,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { Form, Link } from "react-router";
import type { Route } from "./+types/home";
import { requireFlatMember } from "../auth/require";
import { csrfTokenForSession } from "../auth/csrf.server";
import { loadKitchen } from "../lib/kitchen-data";
import { searchRecipes } from "../lib/recipes";
import { KitchenSidebar } from "../components/kitchen-sidebar";

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

  const kitchen = await loadKitchen(ctx.flat.id);
  const csrfToken = csrfTokenForSession(ctx.session.id);
  const list = await searchRecipes({ flatId: ctx.flat.id, query: q });
  return { recipes: list, q, kitchen, csrfToken };
}

// The sidebar POSTs to /kitchen, whose action runs on a sibling route
// and so by default does not invalidate this loader. Force a
// revalidation any time an action completed so the sidebar reflects
// the latest state without requiring a navigation.
export function shouldRevalidate({
  defaultShouldRevalidate,
  actionResult,
}: {
  defaultShouldRevalidate: boolean;
  actionResult: unknown;
}) {
  if (actionResult !== undefined) return true;
  return defaultShouldRevalidate;
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { recipes: list, q, kitchen, csrfToken } = loaderData;

  return (
    <Box px="md" py="md">
      <Grid gap="xl">
        <Grid.Col span={{ base: 12, md: 8 }}>
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
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 4 }} visibleFrom="md">
          <KitchenSidebar
            draft={kitchen.draft}
            stock={kitchen.stock}
            members={kitchen.members}
            csrfToken={csrfToken}
          />
        </Grid.Col>
      </Grid>
    </Box>
  );
}
