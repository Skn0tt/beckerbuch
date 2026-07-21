import { Box, Grid } from "@mantine/core";
import { Suspense } from "react";
import { Await, Outlet } from "react-router";
import type { Route } from "./+types/_workspace";
import { requireFlatMember } from "../auth/require";
import { csrfTokenForSession } from "../auth/csrf.server";
import { loadKitchen } from "../lib/kitchen-data";
import { KitchenSidebar } from "../components/kitchen-sidebar";
import { KitchenSidebarSkeleton } from "../components/app-skeleton";

export async function loader({ request }: Route.LoaderArgs) {
  const ctx = await requireFlatMember(request);
  const csrfToken = csrfTokenForSession(ctx.session.id);
  // Stream the sidebar: auth is enough to paint the shell; kitchen rows
  // fill in when the query lands.
  return {
    kitchen: loadKitchen(ctx.flat.id),
    flatId: ctx.flat.id,
    csrfToken,
  };
}

export function shouldRevalidate({
  actionResult,
}: {
  defaultShouldRevalidate: boolean;
  actionResult: unknown;
}) {
  // Sidebar forms post to /kitchen (a sibling route) via fetchers, so force
  // revalidation after any action to keep draft/stock data fresh.
  if (actionResult !== undefined) return true;
  // Otherwise skip: the sidebar's draft/stock/members data is independent of
  // which recipe (or the home page) is in the Outlet, so re-running the
  // 4-query loadKitchen() on every recipe→recipe / home↔recipe navigation is
  // pure waste that blocks the navigation. This layout stays mounted across
  // those navs, so React Router reuses the already-loaded sidebar data.
  // Only concurrent edits by *other* members are momentarily missed, which is
  // fine for a household app that is already not real-time (the full /kitchen
  // view, outside this layout, always loads fresh).
  return false;
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
          <Suspense fallback={<KitchenSidebarSkeleton />}>
            <Await resolve={kitchen}>
              {(data) => (
                <KitchenSidebar
                  draft={data.draft}
                  stock={data.stock}
                  members={data.members}
                  csrfToken={csrfToken}
                />
              )}
            </Await>
          </Suspense>
        </Grid.Col>
      </Grid>
    </Box>
  );
}
