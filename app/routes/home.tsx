import {
  Box,
  Button,
  Card,
  Group,
  Image,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useDebouncedCallback } from "@mantine/hooks";
import { Suspense, use, useEffect, useState } from "react";
import { Form, Link, useLoaderData, useSubmit } from "react-router";
import type { Route } from "./+types/home";
import { requireFlatMember } from "../auth/require";
import { isPrerenderShellRequest } from "../auth/shell";
import {
  CollectionSkeleton,
  RecipeGridSkeleton,
} from "../components/app-skeleton";
import {
  searchRecipes,
  type RecipeListItem,
} from "../lib/recipes";

export function meta(_: Route.MetaArgs) {
  return [
    { title: "cookbook" },
    { name: "description", content: "Recipe collection + shopping list planner" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  if (isPrerenderShellRequest(request)) {
    return {
      recipes: null as Promise<RecipeListItem[]> | null,
      q: "",
      shell: true as const,
    };
  }

  const ctx = await requireFlatMember(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();

  // Don't await the list — stream the chrome + search bar first, fill the
  // grid when Neon answers. Cuts perceived cold-start wait after the
  // function is awake.
  return {
    recipes: searchRecipes({ flatId: ctx.flat.id, query: q }),
    q,
    shell: false as const,
  };
}

export default function Home() {
  const data = useLoaderData<typeof loader>();
  const submit = useSubmit();

  const debouncedSubmit = useDebouncedCallback((form: HTMLFormElement) => {
    // Replace history after the first search so each keystroke doesn't add a
    // back-button entry; the initial search stays a normal navigation.
    submit(form, { replace: data.q !== "" });
  }, 250);

  if (data.shell || !data.recipes) {
    return <CollectionSkeleton />;
  }

  const { recipes, q } = data;

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
            onChange={(event) => debouncedSubmit(event.currentTarget.form!)}
          />
          <Button component={Link} to="/recipes/new" prefetch="intent" variant="default">
            + New recipe
          </Button>
        </Group>
      </Form>

      <Box style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <StreamingRecipeList recipes={recipes} q={q} />
      </Box>
    </Stack>
  );
}

/**
 * First visit: Suspense shows a grid skeleton. Subsequent search
 * revalidations re-suspend with a new promise — keep the previous list
 * on screen (slightly faded) instead of flashing the skeleton again.
 */
function StreamingRecipeList({
  recipes,
  q,
}: {
  recipes: Promise<RecipeListItem[]>;
  q: string;
}) {
  const [previous, setPrevious] = useState<RecipeListItem[] | null>(null);

  return (
    <Suspense
      fallback={
        previous ? (
          <Box style={{ opacity: 0.55 }} aria-busy="true">
            <RecipeList list={previous} q={q} />
          </Box>
        ) : (
          <RecipeGridSkeleton />
        )
      }
    >
      <ResolvedRecipeList
        recipes={recipes}
        q={q}
        onResolved={setPrevious}
      />
    </Suspense>
  );
}

function ResolvedRecipeList({
  recipes,
  q,
  onResolved,
}: {
  recipes: Promise<RecipeListItem[]>;
  q: string;
  onResolved: (list: RecipeListItem[]) => void;
}) {
  const list = use(recipes);
  useEffect(() => {
    onResolved(list);
  }, [list, onResolved]);
  return <RecipeList list={list} q={q} />;
}

function RecipeList({ list, q }: { list: RecipeListItem[]; q: string }) {
  if (list.length === 0) {
    return (
      <Text c="dimmed">{q ? `No recipes match "${q}"` : "No recipes yet"}</Text>
    );
  }

  return (
    <SimpleGrid cols={{ base: 2, sm: 3, md: 4 }} spacing="md">
      {list.map((r) => (
        <RecipeCard key={r.id} recipe={r} />
      ))}
    </SimpleGrid>
  );
}

function RecipeCard({ recipe: r }: { recipe: RecipeListItem }) {
  return (
    <Card
      component={Link}
      to={`/recipes/${r.id}`}
      prefetch="intent"
      withBorder
      padding="sm"
      radius="md"
    >
      <Card.Section>
        {r.photoBlobKey ? (
          <Image
            src={`/recipes/${r.id}/photo?v=${encodeURIComponent(r.photoBlobKey)}`}
            alt={r.name}
            h={140}
            fit="cover"
          />
        ) : (
          <Box
            h={140}
            bg="var(--mantine-color-gray-1)"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text size="2rem" fw={700} c="dimmed" aria-hidden>
              {r.name.trim().charAt(0).toUpperCase() || "?"}
            </Text>
          </Box>
        )}
      </Card.Section>

      <Text fw={500} mt="sm" lineClamp={2}>
        {r.name}
      </Text>
    </Card>
  );
}
