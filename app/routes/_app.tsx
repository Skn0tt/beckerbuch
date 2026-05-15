import {
  AppShell,
  Box,
  Burger,
  Button,
  Container,
  Group,
  NavLink,
  Text,
  Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { Form, Link, NavLink as RouterNavLink, Outlet, redirect, useLocation } from "react-router";
import type { Route } from "./+types/_app";
import { tryGetAuthedContext } from "../auth/require";
import { csrfTokenForSession } from "../auth/csrf.server";
import { CsrfField } from "../auth/csrf-field";

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
    csrfToken: csrfTokenForSession(ctx.session.id),
  };
}

const NAV_ITEMS = [
  { to: "/", label: "Recipes", end: true },
  { to: "/kitchen", label: "Kitchen" },
  { to: "/flat/settings", label: "Flat settings" },
];

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  const { user, flat, csrfToken } = loaderData;
  const [mobileOpened, { toggle: toggleMobile, close: closeMobile }] =
    useDisclosure(false);
  const location = useLocation();

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{
        width: 220,
        breakpoint: "sm",
        collapsed: { mobile: !mobileOpened, desktop: false },
      }}
      footer={{ height: 60 }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="sm">
            <Burger
              opened={mobileOpened}
              onClick={toggleMobile}
              hiddenFrom="sm"
              size="sm"
              aria-label="Open navigation"
            />
            <Title order={3}>cookbook</Title>
            <Text size="sm" c="dimmed" visibleFrom="sm">
              · {flat.name}
            </Text>
          </Group>
          <Group gap="sm">
            <Text size="sm" c="dimmed" data-testid="current-user">
              {user.displayName}
            </Text>
            <Form method="post" action="/logout">
              <CsrfField token={csrfToken} />
              <Button type="submit" variant="subtle" size="xs">
                Sign out
              </Button>
            </Form>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            component={RouterNavLink}
            to={item.to}
            end={item.end}
            label={item.label}
            active={
              item.end
                ? location.pathname === item.to
                : location.pathname.startsWith(item.to)
            }
            onClick={closeMobile}
          />
        ))}
      </AppShell.Navbar>

      <AppShell.Footer hiddenFrom="sm">
        <Group h="100%" gap={0} grow preventGrowOverflow={false}>
          {NAV_ITEMS.map((item) => {
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
        <Container size="md">
          <Outlet />
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}
