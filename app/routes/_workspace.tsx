import { Box, Grid } from "@mantine/core";
import { Suspense } from "react";
import { Await, Outlet } from "react-router";
import type { Route } from "./+types/_workspace";
import { requireFlatMember } from "../auth/require";
import { isPrerenderShellRequest } from "../auth/shell";
import { csrfTokenForSession } from "../auth/csrf.server";
import { loadKitchen } from "../lib/kitchen-data";
import { KitchenSidebar } from "../components/kitchen-sidebar";
import { KitchenSidebarSkeleton } from "../components/app-skeleton";

export async function loader({ request }: Route.LoaderArgs) {
  if (isPrerenderShellRequest(request)) {
    return {
      kitchen: null,
      flatId: "",
      csrfToken: "",
      shell: true as const,
    };
  }

  const ctx = await requireFlatMember(request);
  const csrfToken = csrfTokenForSession(ctx.session.id);
  // Stream the sidebar: auth is enough to paint the shell; kitchen rows
  // fill in when the query lands.
  return {
    kitchen: loadKitchen(ctx.flat.id),
    flatId: ctx.flat.id,
    csrfToken,
    shell: false as const,
  };
}

export function shouldRevalidate({
  actionResult,
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}: {
  defaultShouldRevalidate: boolean;
  actionResult: unknown;
  currentUrl: URL;
  nextUrl: URL;
}) {
  // Sidebar forms post to /kitchen (a sibling route) via fetchers, so force
  // revalidation after any action to keep draft/stock data fresh.
  if (actionResult !== undefined) return true;
  // Same-URL revalidation (CDN shell boot) must refresh kitchen rows;
  // recipe↔recipe / home↔recipe navigations keep the cached sidebar.
  if (
    currentUrl.pathname === nextUrl.pathname &&
    currentUrl.search === nextUrl.search
  ) {
    return defaultShouldRevalidate;
  }
  // Otherwise skip: the sidebar's draft/stock/members data is independent of
  // which recipe (or the home page) is in the Outlet.
  return false;
}

export default function WorkspaceLayout({ loaderData }: Route.ComponentProps) {
  const { kitchen, csrfToken, shell } = loaderData;

  return (
    <Box px="md" py="md">
      <Grid gap="xl">
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Outlet />
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 4 }} visibleFrom="md">
          {shell || !kitchen ? (
            <KitchenSidebarSkeleton />
          ) : (
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
          )}
        </Grid.Col>
      </Grid>
    </Box>
  );
}
