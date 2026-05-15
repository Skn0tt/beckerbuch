import { Anchor, Button, Container, Group, Stack, Text, Title } from "@mantine/core";
import { Form, useRouteLoaderData } from "react-router";
import type { Route } from "./+types/home";
import type { loader as appLoader } from "./_app";
import { CsrfField } from "../auth/csrf-field";

export function meta(_: Route.MetaArgs) {
  return [
    { title: "cookbook" },
    { name: "description", content: "Recipe collection + shopping list planner" },
  ];
}

export default function Home() {
  const data = useRouteLoaderData("routes/_app") as
    | Awaited<ReturnType<typeof appLoader>>
    | undefined;

  return (
    <Container size="sm" py="xl">
      <Stack gap="md">
        <Group justify="space-between" align="center">
          <Title order={1}>cookbook</Title>
          {data && (
            <Group gap="xs">
              <Anchor href="/flat/settings" size="sm">
                Flat settings
              </Anchor>
              <Form method="post" action="/logout">
                <CsrfField sessionId={data.sessionId} />
                <Button type="submit" variant="subtle" size="xs">
                  Sign out {data.user.displayName}
                </Button>
              </Form>
            </Group>
          )}
        </Group>
        <Text c="dimmed">No recipes yet</Text>
      </Stack>
    </Container>
  );
}

