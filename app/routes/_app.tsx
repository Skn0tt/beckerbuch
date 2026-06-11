import {
  Anchor,
  AppShell,
  Box,
  Group,
  Text,
  Title,
  UnstyledButton,
  VisuallyHidden,
} from "@mantine/core";
import { Link, Outlet, redirect, useLocation } from "react-router";
import type { Route } from "./+types/_app";
import { tryGetAuthedContext } from "../auth/require";
import { UserAvatar } from "../components/user-avatar";

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

export function shouldRevalidate({
  nextUrl,
  actionResult,
}: {
  nextUrl: URL;
  defaultShouldRevalidate: boolean;
  actionResult: unknown;
}) {
  // Settings mutations (rename flat, change display name, avatar) change the
  // { user, flat } shown in the always-mounted header. They post to
  // /flat/settings and redirect back to it, so the revalidating navigation is
  // a plain GET with no actionResult — keep _app fresh whenever the nav lands
  // on settings (a cold page, off the recipe-switching hot path).
  if (actionResult !== undefined) return true;
  if (nextUrl.pathname === "/flat/settings") return true;
  // Otherwise skip: this auth layout stays mounted across every authenticated
  // navigation, and its { user, flat } data is independent of which leaf is in
  // the Outlet. Re-running tryGetAuthedContext() on each nav is a redundant
  // Neon round-trip — every authenticated leaf already calls requireFlatMember
  // in its own loader, so a revoked session is still caught (redirected to
  // /login) without _app re-authing here.
  return false;
}

const MOBILE_NAV = [
  { to: "/", label: "Recipes", end: true },
  { to: "/kitchen", label: "Kitchen" },
];

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  const { user, flat } = loaderData;
  const location = useLocation();

  return (
    <AppShell
      header={{ height: 56 }}
      footer={{ height: { base: 60, md: 0 } }}
      padding={0}
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Anchor
            component={Link}
            to="/"
            prefetch="intent"
            underline="never"
            c="inherit"
          >
            <Title order={3}>{flat.name}</Title>
          </Anchor>
          <Group gap="sm">
            <VisuallyHidden data-testid="current-user">
              {user.displayName}
            </VisuallyHidden>
            <UnstyledButton
              component={Link}
              to="/flat/settings"
              prefetch="intent"
              aria-label="Settings"
              style={{ display: "inline-flex", borderRadius: "50%" }}
            >
              <UserAvatar user={user} size="md" />
            </UnstyledButton>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Footer hiddenFrom="md">
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
                prefetch="intent"
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
