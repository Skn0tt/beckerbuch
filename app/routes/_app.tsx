import {
  ActionIcon,
  Anchor,
  AppShell,
  Box,
  Group,
  Text,
  Title,
  VisuallyHidden,
} from "@mantine/core";
import { Link, Outlet, redirect, useLocation, useNavigate } from "react-router";
import type { Route } from "./+types/_app";
import { tryGetAuthedContext } from "../auth/require";

export async function loader({ request }: Route.LoaderArgs) {
  const ctx = await tryGetAuthedContext(request);
  if (!ctx) {
    const url = new URL(request.url);
    const target = url.pathname + url.search;
    throw redirect(`/login?redirect=${encodeURIComponent(target)}`);
  }
  return {
    user: ctx.user,
    flat: ctx.flat,
  };
}

const MOBILE_NAV = [
  { to: "/", label: "Recipes", end: true },
  { to: "/kitchen", label: "Kitchen" },
];

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  const { user, flat } = loaderData;
  const location = useLocation();
  const navigate = useNavigate();
  const showBackToCollection =
    location.pathname.startsWith("/recipes/") &&
    !location.pathname.endsWith("/edit") &&
    !location.pathname.endsWith("/photo") &&
    location.pathname !== "/recipes/new";
  const canGoBack = location.key !== "default";

  return (
    <AppShell
      header={{ height: 56 }}
      footer={{ height: 60 }}
      padding={0}
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="xs">
            {showBackToCollection && (
              <ActionIcon
                component={Link}
                to="/"
                variant="subtle"
                size="lg"
                aria-label="Back to collection"
                onClick={(event) => {
                  if (!canGoBack) return;
                  event.preventDefault();
                  navigate(-1);
                }}
              >
                ←
              </ActionIcon>
            )}
            <Anchor
              component={Link}
              to="/"
              underline="never"
              c="inherit"
            >
              <Title order={3}>{flat.name}</Title>
            </Anchor>
          </Group>
          <Group gap="sm">
            <VisuallyHidden data-testid="current-user">
              {user.displayName}
            </VisuallyHidden>
            <ActionIcon
              component={Link}
              to="/flat/settings"
              variant="subtle"
              size="lg"
              aria-label="Settings"
            >
              ⚙
            </ActionIcon>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Footer hiddenFrom="sm">
        <Group h="100%" gap={0} grow preventGrowOverflow={false}>
          {MOBILE_NAV.map((item) => {
            const active = item.end
              ? location.pathname === item.to
              : location.pathname.startsWith(item.to);
            return (
              <Box
                key={item.to}
                component={Link}
                to={item.to}
                ta="center"
                py="sm"
                style={{
                  textDecoration: "none",
                  color: "inherit",
                  fontWeight: active ? 600 : 400,
                  background: active ? "var(--mantine-color-default-hover)" : undefined,
                }}
                aria-current={active ? "page" : undefined}
              >
                <Text size="sm">{item.label}</Text>
              </Box>
            );
          })}
        </Group>
      </AppShell.Footer>

      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
