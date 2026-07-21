import {
  Button,
  Code,
  ColorSchemeScript,
  Container,
  Group,
  MantineProvider,
  mantineHtmlProps,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import {
  isRouteErrorResponse,
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import type { Route } from "./+types/root";
import { AppChromeSkeleton } from "./components/app-skeleton";
import "./styles.css";

export const links: Route.LinksFunction = () => [
  { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
  { rel: "manifest", href: "/manifest.webmanifest" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" {...mantineHtmlProps}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#E07856" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="beckerbuch" />
        <meta
          name="apple-mobile-web-app-status-bar-style"
          content="default"
        />
        {/*
          Inline critical paint so the first HTML chunk isn't a white flash
          while Mantine CSS arrives (and so streamed Suspense skeletons sit
          on a calm surface immediately).
        */}
        <style
          dangerouslySetInnerHTML={{
            __html:
              "html,body{background:#f6f5f3;margin:0}html{color-scheme:light dark}",
          }}
        />
        <ColorSchemeScript />
        <Meta />
        <Links />
      </head>
      <body>
        <MantineProvider defaultColorScheme="auto">
          <Notifications />
          {children}
        </MantineProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export function HydrateFallback() {
  return <AppChromeSkeleton />;
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const is404 = isRouteErrorResponse(error) && error.status === 404;
  const isRouteError = isRouteErrorResponse(error);

  let title = "Something went wrong";
  let body = "An unexpected error occurred. Try going back home.";

  if (is404) {
    title = "404 — page not found";
    body = "We couldn't find what you were looking for.";
  } else if (isRouteError) {
    title = `${error.status} — ${error.statusText || "Error"}`;
    body =
      typeof error.data === "string" && error.data.length < 200
        ? error.data
        : body;
  }

  const stack =
    !isRouteError &&
    import.meta.env.DEV &&
    error instanceof Error
      ? error.stack
      : undefined;

  return (
    <Container size="sm" py="xl">
      <Stack gap="md">
        <Title order={1}>{title}</Title>
        <Text c="dimmed">{body}</Text>
        <Group>
          <Button component={Link} to="/" prefetch="intent" variant="filled">
            Back to home
          </Button>
        </Group>
        {stack && (
          <Code block style={{ whiteSpace: "pre-wrap" }}>
            {stack}
          </Code>
        )}
      </Stack>
    </Container>
  );
}
