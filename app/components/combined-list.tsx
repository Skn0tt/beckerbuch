import {
  Badge,
  Button,
  Card,
  Group,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useFetcher } from "react-router";
import type { DedupGroup } from "../db/schema";

/**
 * Shared, mobile-friendly rendering of the LLM-deduped "combined list".
 *
 * Used by both the public handoff page (`h.$flatId.tsx`) and the kitchen's
 * "Planned ingredients" surfaces (mobile `/kitchen` tab + desktop sidebar).
 *
 * The kitchen surfaces render it read-only — a plain shopping summary. Only
 * the handoff page opts into `interactive`, which surfaces the split / unsplit
 * / regenerate affordances (all posting to the handoff action, which is the
 * current route there, so no `actionPath` is needed).
 */
export function CombinedList({
  combinedGroups,
  rejectedIds,
  snapshotFresh,
  title,
  interactive = false,
  showSingletonSource = false,
  emptyState,
}: {
  combinedGroups: DedupGroup[];
  rejectedIds: string[];
  snapshotFresh: boolean;
  title?: string;
  interactive?: boolean;
  showSingletonSource?: boolean;
  emptyState?: React.ReactNode;
}) {
  const rejectedSet = new Set(rejectedIds);
  const fetcher = useFetcher();

  // Scope pending UI to the specific in-flight action: while the fetcher is
  // busy, `fetcher.formData` holds the submitted form, so we can tell whether
  // it's a regenerate or a per-row split/unsplit.
  const pending =
    interactive && fetcher.state !== "idle" ? fetcher.formData : null;
  const regenerating = pending?.get("intent") === "regenerate";
  const pendingGroupId = pending?.get("groupId");

  const regenerate =
    interactive && !snapshotFresh ? (
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="regenerate" />
        <Button
          type="submit"
          size="xs"
          variant="light"
          color="yellow"
          loading={regenerating}
        >
          Regenerate
        </Button>
      </fetcher.Form>
    ) : null;

  if (combinedGroups.length === 0 && emptyState) {
    return (
      <Stack gap="xs" data-testid="combined-list">
        {title && (
          <Title order={2} size="h4">
            {title}
          </Title>
        )}
        {emptyState}
      </Stack>
    );
  }

  return (
    <Stack gap="xs" data-testid="combined-list">
      {title ? (
        <Group justify="space-between" align="center" wrap="nowrap">
          <Title order={2} size="h4">
            {title}
          </Title>
          {regenerate}
        </Group>
      ) : (
        regenerate && (
          <Group justify="flex-end" align="center">
            {regenerate}
          </Group>
        )
      )}

      {interactive && !snapshotFresh && (
        <Text size="xs" c="dimmed">
          Shopping list changed since finalise — showing all ingredients
          unmerged.
        </Text>
      )}

      <Stack
        gap={6}
        style={
          regenerating ? { opacity: 0.5, pointerEvents: "none" } : undefined
        }
        aria-busy={regenerating || undefined}
      >
        {combinedGroups.map((g) => {
          const isMerged = g.sources.length > 1;
          const isRejected = rejectedSet.has(g.id);
          return (
            <Card
              key={g.id}
              withBorder
              radius="md"
              padding="sm"
              data-testid="combined-row"
              data-merged={isMerged ? "true" : "false"}
              data-rejected={isRejected ? "true" : "false"}
            >
              <Group
                justify="space-between"
                align="flex-start"
                wrap="nowrap"
                gap="sm"
              >
                <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
                  {isMerged && !isRejected && (
                    <Group gap="xs" align="center" wrap="wrap">
                      <Text
                        size="sm"
                        fw={600}
                        style={{ wordBreak: "break-word" }}
                      >
                        {g.displayText}
                      </Text>
                      <Badge size="xs" variant="light" radius="sm">
                        {g.sources.length}×
                      </Badge>
                    </Group>
                  )}
                  {!isMerged && (
                    <Text
                      size="sm"
                      fw={500}
                      style={{ wordBreak: "break-word" }}
                    >
                      {g.displayText}
                    </Text>
                  )}
                  {isMerged &&
                    g.sources.map((s) => (
                      <Text
                        key={s.id}
                        size="xs"
                        c="dimmed"
                        style={{ wordBreak: "break-word" }}
                      >
                        {isRejected ? "" : "· "}
                        {s.displayText}{" "}
                        <Text span size="xs" c="dimmed">
                          — {s.recipeName}
                        </Text>
                      </Text>
                    ))}
                  {!isMerged && showSingletonSource && g.sources[0] && (
                    <Text
                      size="xs"
                      c="dimmed"
                      style={{ wordBreak: "break-word" }}
                    >
                      {g.sources[0].recipeName}
                    </Text>
                  )}
                </Stack>
                {interactive && isMerged && (
                  <fetcher.Form method="post">
                    <input
                      type="hidden"
                      name="intent"
                      value={isRejected ? "unsplit" : "split"}
                    />
                    <input type="hidden" name="groupId" value={g.id} />
                    <Button
                      type="submit"
                      size="xs"
                      variant="subtle"
                      loading={pendingGroupId === g.id}
                      aria-label={
                        isRejected
                          ? `Undo split for ${g.item}`
                          : `Split ${g.item}`
                      }
                    >
                      {isRejected ? "Undo split" : "Split"}
                    </Button>
                  </fetcher.Form>
                )}
              </Group>
            </Card>
          );
        })}
      </Stack>
    </Stack>
  );
}
