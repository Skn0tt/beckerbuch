import { Box, Grid } from "@mantine/core";
import { Outlet } from "react-router";
import type { Route } from "./+types/_workspace";
import { requireFlatMember } from "../auth/require";
import { csrfTokenForSession } from "../auth/csrf.server";
import { loadKitchen } from "../lib/kitchen-data";
import { KitchenSidebar } from "../components/kitchen-sidebar";

export async function loader({ request }: Route.LoaderArgs) {
  const ctx = await requireFlatMember(request);
  const kitchen = await loadKitchen(ctx.flat.id);
  const csrfToken = csrfTokenForSession(ctx.session.id);
  return { kitchen, csrfToken };
}

export function shouldRevalidate({
  defaultShouldRevalidate,
  actionResult,
}: {
  defaultShouldRevalidate: boolean;
  actionResult: unknown;
}) {
  // Sidebar forms post to /kitchen (a sibling route), so force
  // revalidation after any action to keep draft/stock data fresh.
  if (actionResult !== undefined) return true;
  return defaultShouldRevalidate;
}

export default function WorkspaceLayout({ loaderData }: Route.ComponentProps) {
  const { kitchen, csrfToken } = loaderData;

  return (
    <Box px="md" py="md">
      <Grid gap="xl">
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Outlet />
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
