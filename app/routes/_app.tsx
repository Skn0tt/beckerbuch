import {
  ActionIcon,
  Anchor,
  AppShell,
  Box,
  Group,
  Text,
  Title,
  UnstyledButton,
  VisuallyHidden,
} from "@mantine/core";
import { useEffect, useState } from "react";
import {
  Link,
  Outlet,
  redirect,
  useLocation,
  useNavigate,
  useNavigation,
  useRevalidator,
  type ShouldRevalidateFunctionArgs,
} from "react-router";
import type { Route } from "./+types/_app";
import { tryGetAuthedContext } from "../auth/require";
import { isPrerenderShellRequest } from "../auth/shell";
import { UserAvatar } from "../components/user-avatar";

type AppUser = {
  id: string;
  email: string;
  displayName: string;
  avatarKey: string | null;
};
type AppFlat = { id: string; name: string };

export async function loader({ request }: Route.LoaderArgs) {
  if (isPrerenderShellRequest(request)) {
    return {
      shell: true as const,
      user: null as AppUser | null,
      flat: null as AppFlat | null,
    };
  }

  const ctx = await tryGetAuthedContext(request);
  if (!ctx) {
    const url = new URL(request.url);
    const target = url.pathname + url.search;
    throw redirect(`/login?redirect=${encodeURIComponent(target)}`);
  }
  return {
    shell: false as const,
    user: ctx.user,
    flat: ctx.flat,
  };
}

export function shouldRevalidate({
  currentUrl,
  nextUrl,
  actionResult,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  // Settings mutations (rename flat, change display name, avatar) change the
  // { user, flat } shown in the always-mounted header. They post to
  // /flat/settings and redirect back to it, so the revalidating navigation is
  // a plain GET with no actionResult — keep _app fresh whenever the nav lands
  // on settings (a cold page, off the recipe-switching hot path).
  if (actionResult !== undefined) return true;
  if (nextUrl.pathname === "/flat/settings") return true;
  // Same-URL revalidation (CDN shell boot) must refresh auth chrome.
  if (
    currentUrl.pathname === nextUrl.pathname &&
    currentUrl.search === nextUrl.search
  ) {
    return defaultShouldRevalidate;
  }
  // Otherwise skip: this auth layout stays mounted across every authenticated
  // navigation, and its { user, flat } data is independent of which leaf is in
  // the Outlet.
  return false;
}

const MOBILE_NAV = [
  { to: "/", label: "Recipes", end: true },
  { to: "/kitchen", label: "Kitchen" },
];

// Top-level destinations reachable from the mobile tab bar. On these there is
// nowhere to go "back" to, so the header back arrow is hidden.
const TOP_LEVEL_ROUTES = new Set(["/", "/kitchen"]);

type BootPayload = { user: AppUser; flat: AppFlat };

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  const [shellBoot, setShellBoot] = useState<BootPayload | null>(null);
  const revalidator = useRevalidator();
  const location = useLocation();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const isNavigating = navigation.state !== "idle";

  useEffect(() => {
    if (!loaderData.shell || shellBoot) return;
    let cancelled = false;
    void (async () => {
      const res = await fetch("/data/app", { credentials: "same-origin" });
      if (cancelled) return;
      if (res.status === 401) {
        window.location.assign(
          `/login?redirect=${encodeURIComponent(
            `${location.pathname}${location.search}`,
          )}`,
        );
        return;
      }
      if (!res.ok) throw new Error(`App bootstrap failed (${res.status})`);
      const payload = (await res.json()) as BootPayload;
      if (cancelled) return;
      setShellBoot(payload);
      await revalidator.revalidate();
    })();
    return () => {
      cancelled = true;
    };
  }, [
    loaderData.shell,
    shellBoot,
    revalidator,
    location.pathname,
    location.search,
  ]);

  const user = loaderData.shell
    ? (shellBoot?.user ?? null)
    : loaderData.user;
  const flat = loaderData.shell
    ? (shellBoot?.flat ?? null)
    : loaderData.flat;

  const showBack = !TOP_LEVEL_ROUTES.has(location.pathname);

  const goBack = () => {
    // location.key is "default" for the first entry in the history stack, i.e.
    // when the app was cold-started on this route (deep link / PWA launch) and
    // there is no in-app page to pop back to. Fall back to the collection.
    if (location.key === "default") {
      navigate("/");
    } else {
      navigate(-1);
    }
  };

  return (
    <AppShell
      header={{ height: 56 }}
      footer={{ height: { base: 60, md: 0 } }}
      padding={0}
    >
      {/*
        Do not set position on Header — Mantine's fixed header is the
        containing block for the absolute nav-progress bar. Overriding it
        to `relative` puts the header back in flow and doubles the main
        offset (header height + --app-shell-header-offset padding).
      */}
      <AppShell.Header>
        {isNavigating && (
          <Box
            data-testid="nav-progress"
            aria-hidden
            className="nav-progress"
          />
        )}
        <Group h="100%" px="md" justify="space-between">
          <Group gap="xs" wrap="nowrap">
            {/* Always mount the back slot (toggling only visibility) so the
                flat name keeps the same x-position across top-level and
                sub-routes — otherwise the heading shifts ~44px when the
                button appears/disappears. */}
            <ActionIcon
              variant="subtle"
              color="gray"
              size="lg"
              aria-label="Back"
              onClick={goBack}
              tabIndex={showBack ? undefined : -1}
              aria-hidden={showBack ? undefined : true}
              style={{ visibility: showBack ? "visible" : "hidden" }}
            >
              <Text component="span" fz={24} lh={1}>
                ←
              </Text>
            </ActionIcon>
            <Anchor
              component={Link}
              to="/"
              prefetch="intent"
              underline="never"
              c="inherit"
              data-testid="flat-name"
            >
              <Title order={3}>{flat?.name ?? "Cookbook"}</Title>
            </Anchor>
          </Group>
          <Group gap="sm">
            {user ? (
              <>
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
              </>
            ) : null}
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
                  background: active
                    ? "var(--mantine-color-default-hover)"
                    : undefined,
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
        {/*
          Always render the outlet so prerendered child shells (recipe grid /
          kitchen sidebar skeletons) paint immediately. Real user/flat arrive
          after /data/app + revalidate.
        */}
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
