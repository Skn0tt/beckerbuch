import {
  ActionIcon,
  Anchor,
  Avatar,
  Button,
  Card,
  Group,
  List,
  Modal,
  Popover,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useEffect, useRef, useState } from "react";
import { Form, Link, useFetcher } from "react-router";
import { csrfFieldName } from "../auth/csrf-shared";
import { CsrfField } from "../auth/csrf-field";
import { UserAvatar } from "./user-avatar";
import { formatIngredient as fmtIngredient } from "../lib/scale";
import type { KitchenEntry, KitchenMember } from "../lib/kitchen-data";

function formatIngredient(
  ing: KitchenEntry["ingredients"][number],
  factor: number,
): string {
  return fmtIngredient(ing, factor);
}

function NoteEditor({
  entry,
  csrfToken,
  formAction,
}: {
  entry: KitchenEntry;
  csrfToken: string;
  formAction?: string;
}) {
  const fetcher = useFetcher({ key: `note-${entry.id}` });
  const submittedNote = fetcher.formData?.get("note");
  const optimistic =
    submittedNote != null ? String(submittedNote).trim() : null;
  const persisted = entry.note ?? null;
  const current =
    submittedNote != null
      ? optimistic && optimistic.length > 0
        ? optimistic
        : null
      : persisted;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(current ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEditing = () => {
    setDraft(current ?? "");
    setEditing(true);
  };

  const submit = (value: string) => {
    const fd = new FormData();
    fd.set(csrfFieldName(), csrfToken);
    fd.set("intent", "set-note");
    fd.set("instanceId", entry.id);
    fd.set("note", value);
    fetcher.submit(fd, { method: "post", ...(formAction ? { action: formAction } : {}) });
    setEditing(false);
  };

  if (editing) {
    return (
      <Group gap="xs" wrap="nowrap">
        <TextInput
          ref={inputRef}
          size="xs"
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit(draft);
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
          placeholder="e.g. cook this on Friday"
          aria-label={`Note for ${entry.recipeName}`}
          style={{ flex: 1 }}
          data-testid="note-input"
        />
        <Button
          type="button"
          size="xs"
          variant="light"
          onClick={() => submit(draft)}
        >
          Save
        </Button>
        {current && (
          <Button
            type="button"
            size="xs"
            variant="subtle"
            color="red"
            onClick={() => submit("")}
            aria-label={`Clear note for ${entry.recipeName}`}
          >
            Clear
          </Button>
        )}
      </Group>
    );
  }

  if (current) {
    return (
      <Group gap="xs" wrap="nowrap" align="center">
        <Text size="sm" fs="italic" c="dimmed" style={{ flex: 1 }} data-testid="note-text">
          📝 {current}
        </Text>
        <Button
          type="button"
          size="compact-xs"
          variant="subtle"
          onClick={startEditing}
          aria-label={`Edit note for ${entry.recipeName}`}
        >
          Edit
        </Button>
      </Group>
    );
  }

  return (
    <Button
      type="button"
      size="compact-xs"
      variant="subtle"
      c="dimmed"
      onClick={startEditing}
      aria-label={`Add note for ${entry.recipeName}`}
      style={{ alignSelf: "flex-start" }}
    >
      + Note
    </Button>
  );
}

function MoveButtons({
  entry,
  csrfToken,
  isFirst,
  isLast,
  formAction,
}: {
  entry: KitchenEntry;
  csrfToken: string;
  isFirst: boolean;
  isLast: boolean;
  formAction?: string;
}) {
  return (
    <Group gap={2} wrap="nowrap">
      <Form method="post" action={formAction}>
        <CsrfField token={csrfToken} />
        <input type="hidden" name="intent" value="move" />
        <input type="hidden" name="instanceId" value={entry.id} />
        <input type="hidden" name="direction" value="up" />
        <ActionIcon
          type="submit"
          variant="default"
          size="sm"
          disabled={isFirst}
          aria-label={`Move ${entry.recipeName} up`}
        >
          ↑
        </ActionIcon>
      </Form>
      <Form method="post" action={formAction}>
        <CsrfField token={csrfToken} />
        <input type="hidden" name="intent" value="move" />
        <input type="hidden" name="instanceId" value={entry.id} />
        <input type="hidden" name="direction" value="down" />
        <ActionIcon
          type="submit"
          variant="default"
          size="sm"
          disabled={isLast}
          aria-label={`Move ${entry.recipeName} down`}
        >
          ↓
        </ActionIcon>
      </Form>
    </Group>
  );
}

function UnassignedAvatar({ size = "sm" }: { size?: number | string }) {
  return (
    <Avatar
      radius="xl"
      variant="default"
      size={size}
      style={{ borderStyle: "dashed" }}
    >
      ?
    </Avatar>
  );
}

function CookPicker({
  entry,
  members,
  effectiveCookId,
  submitCook,
}: {
  entry: KitchenEntry;
  members: KitchenMember[];
  effectiveCookId: string | null;
  submitCook: (cookId: string) => void;
}) {
  const [opened, setOpened] = useState(false);
  const selectedMember =
    effectiveCookId === null
      ? null
      : (members.find((m) => m.id === effectiveCookId) ?? null);
  return (
    <Group justify="space-between" align="center" wrap="nowrap" gap="xs">
      <Text size="sm" c="dimmed">
        Cook:
      </Text>
      <Popover
        opened={opened}
        onChange={setOpened}
        width={240}
        position="bottom-end"
        withArrow
      >
        <Popover.Target>
          <Button
            variant="default"
            size="compact-sm"
            px={6}
            aria-label={`Choose cook for ${entry.recipeName}`}
            onClick={() => setOpened((v) => !v)}
          >
            {selectedMember ? (
              <UserAvatar user={selectedMember} size="sm" />
            ) : (
              <UnassignedAvatar size="sm" />
            )}
          </Button>
        </Popover.Target>
        <Popover.Dropdown p={6}>
          <Stack gap={4}>
            <Button
              fullWidth
              variant={effectiveCookId === null ? "light" : "subtle"}
              justify="flex-start"
              leftSection={<UnassignedAvatar size="sm" />}
              size="xs"
              onClick={() => {
                submitCook("");
                setOpened(false);
              }}
              aria-label={`Set cook to unassigned for ${entry.recipeName}`}
              aria-pressed={effectiveCookId === null}
            >
              Unassigned
            </Button>
            {members.map((m) => (
              <Button
                key={m.id}
                fullWidth
                justify="flex-start"
                variant={effectiveCookId === m.id ? "light" : "subtle"}
                leftSection={<UserAvatar user={m} size="sm" />}
                size="xs"
                onClick={() => {
                  submitCook(m.id);
                  setOpened(false);
                }}
                aria-label={`Set cook to ${m.displayName} for ${entry.recipeName}`}
                aria-pressed={effectiveCookId === m.id}
              >
                {m.displayName}
              </Button>
            ))}
          </Stack>
        </Popover.Dropdown>
      </Popover>
    </Group>
  );
}

export function DraftCard({
  entry,
  csrfToken,
  members,
  isFirst,
  isLast,
  formAction,
}: {
  entry: KitchenEntry;
  csrfToken: string;
  members: KitchenMember[];
  isFirst: boolean;
  isLast: boolean;
  formAction?: string;
}) {
  const fetcher = useFetcher();
  const pending = fetcher.formData?.get("targetQuantity");
  const target =
    typeof pending === "string" && Number.isFinite(Number(pending))
      ? Number(pending)
      : entry.targetQuantity;

  const factor = entry.baseQuantity > 0 ? target / entry.baseQuantity : 1;

  const submitTarget = (next: number) => {
    if (next < 1) return;
    const fd = new FormData();
    fd.set("intent", "update-quantity");
    fd.set("instanceId", entry.id);
    fd.set("targetQuantity", String(next));
    fd.set(csrfFieldName(), csrfToken);
    fetcher.submit(fd, { method: "post", ...(formAction ? { action: formAction } : {}) });
  };

  const cookFetcher = useFetcher();
  const pendingCookRaw = cookFetcher.formData?.get("cookId");
  const pendingCook =
    typeof pendingCookRaw === "string" ? pendingCookRaw : null;
  const effectiveCookId =
    pendingCook === null
      ? entry.designatedCookId
      : pendingCook === ""
        ? null
        : pendingCook;
  const submitCook = (cookId: string) => {
    const fd = new FormData();
    fd.set("intent", "set-cook");
    fd.set("instanceId", entry.id);
    fd.set("cookId", cookId);
    fd.set(csrfFieldName(), csrfToken);
    cookFetcher.submit(fd, { method: "post", ...(formAction ? { action: formAction } : {}) });
  };

  return (
    <Card withBorder padding="sm">
      <Stack gap="xs">
        <Group justify="space-between" align="center" wrap="nowrap">
          <Group gap="xs" wrap="nowrap">
            <MoveButtons
              entry={entry}
              csrfToken={csrfToken}
              isFirst={isFirst}
              isLast={isLast}
              formAction={formAction}
            />
            <Anchor component={Link} to={`/recipes/${entry.recipeId}`} fw={500}>
              {entry.recipeName}
            </Anchor>
          </Group>
          <Group gap="xs" wrap="nowrap">
            <Group gap={4} wrap="nowrap">
              <ActionIcon
                variant="default"
                size="sm"
                type="button"
                aria-label={`Decrease ${entry.recipeName} portions`}
                onClick={() => submitTarget(Math.max(1, target - 1))}
              >
                −
              </ActionIcon>
              <Text size="sm" w={28} ta="center" aria-live="polite">
                {target}
              </Text>
              <ActionIcon
                variant="default"
                size="sm"
                type="button"
                aria-label={`Increase ${entry.recipeName} portions`}
                onClick={() => submitTarget(target + 1)}
              >
                +
              </ActionIcon>
              <Text size="sm" c="dimmed">
                portions
              </Text>
            </Group>
            <Form method="post" action={formAction}>
              <CsrfField token={csrfToken} />
              <input type="hidden" name="intent" value="remove-from-draft" />
              <input type="hidden" name="instanceId" value={entry.id} />
              <Button
                type="submit"
                color="red"
                variant="subtle"
                size="xs"
                aria-label={`Remove ${entry.recipeName} from draft`}
              >
                Remove
              </Button>
            </Form>
          </Group>
        </Group>

        <CookPicker
          entry={entry}
          members={members}
          effectiveCookId={effectiveCookId}
          submitCook={submitCook}
        />

        <NoteEditor entry={entry} csrfToken={csrfToken} formAction={formAction} />

        <List spacing={2} size="sm" c="dimmed" withPadding>
          {entry.ingredients.map((i) => (
            <List.Item key={i.position}>{formatIngredient(i, factor)}</List.Item>
          ))}
        </List>
      </Stack>
    </Card>
  );
}

export function StockCard({
  entry,
  csrfToken,
  members,
  isFirst,
  isLast,
  formAction,
}: {
  entry: KitchenEntry;
  csrfToken: string;
  members: KitchenMember[];
  isFirst: boolean;
  isLast: boolean;
  formAction?: string;
}) {
  const factor =
    entry.baseQuantity > 0 ? entry.targetQuantity / entry.baseQuantity : 1;
  const cookFetcher = useFetcher();
  const pendingCookRaw = cookFetcher.formData?.get("cookId");
  const pendingCook =
    typeof pendingCookRaw === "string" ? pendingCookRaw : null;
  const effectiveCookId =
    pendingCook === null
      ? entry.designatedCookId
      : pendingCook === ""
        ? null
        : pendingCook;
  const submitCook = (cookId: string) => {
    const fd = new FormData();
    fd.set("intent", "set-cook");
    fd.set("instanceId", entry.id);
    fd.set("cookId", cookId);
    fd.set(csrfFieldName(), csrfToken);
    cookFetcher.submit(fd, { method: "post", ...(formAction ? { action: formAction } : {}) });
  };
  return (
    <Card withBorder padding="sm">
      <Stack gap="xs">
        <Group justify="space-between" align="center" wrap="nowrap">
          <Group gap="xs" wrap="nowrap">
            <MoveButtons
              entry={entry}
              csrfToken={csrfToken}
              isFirst={isFirst}
              isLast={isLast}
              formAction={formAction}
            />
            <Anchor component={Link} to={`/recipes/${entry.recipeId}`} fw={500}>
              {entry.recipeName}
            </Anchor>
          </Group>
          <Group gap="xs" wrap="nowrap">
            <Text size="sm" c="dimmed">
              {entry.targetQuantity} portions
            </Text>
            <Form method="post" action={formAction}>
              <CsrfField token={csrfToken} />
              <input type="hidden" name="intent" value="mark-cooked" />
              <input type="hidden" name="instanceId" value={entry.id} />
              <Button
                type="submit"
                color="green"
                variant="light"
                size="xs"
                aria-label={`Mark ${entry.recipeName} as cooked`}
              >
                ✓ Cooked
              </Button>
            </Form>
          </Group>
        </Group>
        <CookPicker
          entry={entry}
          members={members}
          effectiveCookId={effectiveCookId}
          submitCook={submitCook}
        />
        <NoteEditor entry={entry} csrfToken={csrfToken} formAction={formAction} />
        <List spacing={2} size="sm" c="dimmed" withPadding>
          {entry.ingredients.map((i) => (
            <List.Item key={i.position}>{formatIngredient(i, factor)}</List.Item>
          ))}
        </List>
      </Stack>
    </Card>
  );
}

export function FinaliseButton({
  csrfToken,
  draft,
  stockCount,
  formAction,
}: {
  csrfToken: string;
  draft: KitchenEntry[];
  stockCount: number;
  formAction?: string;
}) {
  const [opened, { open, close }] = useDisclosure(false);
  return (
    <>
      <Group justify="flex-end" mt="sm">
        <Button onClick={open} aria-label="Finalise draft">
          Finalise →
        </Button>
      </Group>
      <Modal opened={opened} onClose={close} title="Finalise this draft?">
        <Stack gap="sm">
          <Text size="sm">This will:</Text>
          <List size="sm" withPadding>
            <List.Item>Move {draft.length} recipe(s) to In stock</List.Item>
            <List.Item>Empty the draft</List.Item>
            {stockCount > 0 ? (
              <List.Item>
                Send all {stockCount + draft.length} in-stock recipe(s) to the
                handoff page — including {stockCount} already there
              </List.Item>
            ) : (
              <List.Item>Open the Bring! handoff page</List.Item>
            )}
          </List>
          <Text size="sm" fw={500}>
            Recipes:
          </Text>
          <List size="sm" withPadding>
            {draft.map((d) => (
              <List.Item key={d.id}>
                {d.recipeName} (serves {d.targetQuantity})
              </List.Item>
            ))}
          </List>
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={close}>
              Cancel
            </Button>
            <Form method="post" action={formAction}>
              <CsrfField token={csrfToken} />
              <input type="hidden" name="intent" value="finalise" />
              <Button type="submit" aria-label="Confirm finalise draft">
                Finalise →
              </Button>
            </Form>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

/**
 * Compact Draft + In-stock + Finalise tree. Rendered as the right
 * sidebar on the desktop home page; the /kitchen route uses the
 * individual cards directly with its own lane switcher.
 *
 * All inner forms POST to `formAction` (default `/kitchen`) so the
 * kitchen route's action handler stays the single source of truth.
 */
export function KitchenSidebar({
  draft,
  stock,
  members,
  csrfToken,
  formAction = "/kitchen",
}: {
  draft: KitchenEntry[];
  stock: KitchenEntry[];
  members: KitchenMember[];
  csrfToken: string;
  formAction?: string;
}) {
  return (
    <Stack gap="md" component="aside" aria-label="Kitchen">
      <Group justify="space-between" align="baseline">
        <Title order={4}>Draft ({draft.length})</Title>
        <Anchor component={Link} to="/kitchen" size="sm">
          Kitchen ↗
        </Anchor>
      </Group>
      {draft.length === 0 ? (
        <Text size="sm" c="dimmed">
          Draft is empty — add recipes from the collection.
        </Text>
      ) : (
        <Stack gap="xs">
          {draft.map((d, i) => (
            <DraftCard
              key={d.id}
              entry={d}
              csrfToken={csrfToken}
              members={members}
              isFirst={i === 0}
              isLast={i === draft.length - 1}
              formAction={formAction}
            />
          ))}
          <FinaliseButton
            csrfToken={csrfToken}
            draft={draft}
            stockCount={stock.length}
            formAction={formAction}
          />
        </Stack>
      )}

      <Title order={4}>In stock ({stock.length})</Title>
      {stock.length === 0 ? (
        <Text size="sm" c="dimmed">
          Nothing in stock yet — finalise the draft to start cooking.
        </Text>
      ) : (
        <Stack gap="xs">
          {stock.map((s, i) => (
              <StockCard
                key={s.id}
                entry={s}
                csrfToken={csrfToken}
                members={members}
                isFirst={i === 0}
                isLast={i === stock.length - 1}
                formAction={formAction}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
}
