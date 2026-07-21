import {
  Box,
  Card,
  Grid,
  Group,
  SimpleGrid,
  Skeleton,
  Stack,
} from "@mantine/core";

/**
 * Placeholders that mirror the resting workspace chrome so cold starts and
 * streamed loaders feel occupied instead of blank while Neon / the function
 * catch up.
 */

export function RecipeGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <SimpleGrid
      cols={{ base: 2, sm: 3, md: 4 }}
      spacing="md"
      aria-busy="true"
      aria-label="Loading recipes"
    >
      {Array.from({ length: count }, (_, i) => (
        <Card key={i} withBorder padding="sm" radius="md">
          <Skeleton height={140} radius={0} />
          <Skeleton height={14} mt="sm" width="75%" />
        </Card>
      ))}
    </SimpleGrid>
  );
}

export function CollectionSkeleton() {
  return (
    <Stack gap="md" aria-busy="true" aria-label="Loading collection">
      <Group gap="sm" wrap="nowrap" align="stretch">
        <Skeleton height={36} style={{ flex: 1 }} radius="sm" />
        <Skeleton height={36} width={118} radius="sm" />
      </Group>
      <RecipeGridSkeleton />
    </Stack>
  );
}

export function KitchenSidebarSkeleton() {
  return (
    <Stack gap="lg" aria-busy="true" aria-label="Loading kitchen">
      <Stack gap="sm">
        <Group justify="space-between">
          <Skeleton height={22} width={72} />
          <Skeleton height={22} width={28} />
        </Group>
        <Skeleton height={72} radius="md" />
        <Skeleton height={72} radius="md" />
      </Stack>
      <Stack gap="sm">
        <Skeleton height={22} width={96} />
        <Skeleton height={72} radius="md" />
      </Stack>
    </Stack>
  );
}

export function KitchenPageSkeleton() {
  return (
    <Stack gap="md" aria-busy="true" aria-label="Loading kitchen">
      <Skeleton height={36} radius="sm" />
      <Skeleton height={80} radius="md" />
      <Skeleton height={80} radius="md" />
      <Skeleton height={80} radius="md" />
    </Stack>
  );
}

export function WorkspaceSkeleton() {
  return (
    <Box px="md" py="md">
      <Grid gap="xl">
        <Grid.Col span={{ base: 12, md: 8 }}>
          <CollectionSkeleton />
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 4 }} visibleFrom="md">
          <KitchenSidebarSkeleton />
        </Grid.Col>
      </Grid>
    </Box>
  );
}

/** Full authenticated chrome — used as the root HydrateFallback. */
export function AppChromeSkeleton() {
  return (
    <Box data-testid="app-chrome-skeleton">
      <Box
        h={56}
        px="md"
        style={{
          borderBottom: "1px solid var(--mantine-color-default-border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Skeleton height={22} width={140} />
        <Skeleton height={36} circle />
      </Box>
      <WorkspaceSkeleton />
    </Box>
  );
}
