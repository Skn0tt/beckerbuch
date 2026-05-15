import { Container, Stack, Text, Title } from "@mantine/core";
import type { Route } from "./+types/home";

export function meta(_: Route.MetaArgs) {
  return [
    { title: "cookbook" },
    { name: "description", content: "Recipe collection + shopping list planner" },
  ];
}

export default function Home() {
  return (
    <Container size="sm" py="xl">
      <Stack gap="md">
        <Title order={1}>cookbook</Title>
        <Text c="dimmed">No recipes yet</Text>
      </Stack>
    </Container>
  );
}
