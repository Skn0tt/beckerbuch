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
  UnstyledButton,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Form, Link, useFetcher, useNavigation } from "react-router";
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { csrfFieldName } from "../auth/csrf-shared";
import { CsrfField } from "../auth/csrf-field";
import { UserAvatar } from "./user-avatar";
import type { KitchenEntry, KitchenMember } from "../lib/kitchen-data";

type Lane = "draft" | "stock";
const kitchenMobileQuery = "(max-width: 48em)";

function NoteEditor({
  entry,
  csrfToken,
  formAction,
  compactWhenEmpty = false,
}: {
  entry: KitchenEntry;
  csrfToken: string;
  formAction?: string;
  compactWhenEmpty?: boolean;
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
      <TextInput
        ref={inputRef}
        size="xs"
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={() => submit(draft)}
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
        data-testid="note-input"
      />
    );
  }

  if (current) {
    return (
      <UnstyledButton
        onClick={startEditing}
        aria-label={`Edit note for ${entry.recipeName}`}
        style={{ display: "block", width: "100%", textAlign: "left" }}
      >
        <Text size="sm" fs="italic" c="dimmed" data-testid="note-text">
          {current}
        </Text>
      </UnstyledButton>
    );
  }

  return (
    <Button
      type="button"
      size={compactWhenEmpty ? "xs" : "compact-xs"}
      variant="subtle"
      c="dimmed"
      onClick={startEditing}
      aria-label={`Add note for ${entry.recipeName}`}
      style={compactWhenEmpty ? undefined : { alignSelf: "flex-start" }}
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
      size={size}
      style={
        {
          "--avatar-bg": "var(--mantine-color-gray-1)",
          "--avatar-color": "var(--mantine-color-gray-5)",
        } as React.CSSProperties
      }
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
    <Popover
      opened={opened}
      onChange={setOpened}
      width={240}
      position="bottom-end"
      withArrow
    >
      <Popover.Target>
        <UnstyledButton
          aria-label={`Choose cook for ${entry.recipeName}`}
          onClick={() => setOpened((v) => !v)}
          style={{ display: "inline-flex", borderRadius: "50%" }}
        >
          {selectedMember ? (
            <UserAvatar user={selectedMember} size="sm" />
          ) : (
            <UnassignedAvatar size="sm" />
          )}
        </UnstyledButton>
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
  );
}

export function DraftCard({
  entry,
  csrfToken,
  members,
  isFirst,
  isLast,
  formAction,
  dragHandle,
}: {
  entry: KitchenEntry;
  csrfToken: string;
  members: KitchenMember[];
  isFirst: boolean;
  isLast: boolean;
  formAction?: string;
  dragHandle?: ReactNode;
}) {
  const fetcher = useFetcher();
  const pending = fetcher.formData?.get("targetQuantity");
  const target =
    typeof pending === "string" && Number.isFinite(Number(pending))
      ? Number(pending)
      : entry.targetQuantity;

  const removeFetcher = useFetcher();
  const isMobile = useMediaQuery(kitchenMobileQuery);
  const [confirmRemove, { open: openConfirm, close: closeConfirm }] =
    useDisclosure(false);

  const submitTarget = (next: number) => {
    if (next < 1) {
      openConfirm();
      return;
    }
    const fd = new FormData();
    fd.set("intent", "update-quantity");
    fd.set("instanceId", entry.id);
    fd.set("targetQuantity", String(next));
    fd.set(csrfFieldName(), csrfToken);
    fetcher.submit(fd, { method: "post", ...(formAction ? { action: formAction } : {}) });
  };

  const confirmRemoveSubmit = () => {
    const fd = new FormData();
    fd.set("intent", "remove-from-draft");
    fd.set("instanceId", entry.id);
    fd.set(csrfFieldName(), csrfToken);
    removeFetcher.submit(fd, {
      method: "post",
      ...(formAction ? { action: formAction } : {}),
    });
    closeConfirm();
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
  const showInlineAddNote = isMobile && !entry.note;

  return (
    <Card withBorder padding="sm">
      <Stack gap="xs">
        <Group
          justify="space-between"
          align={isMobile ? "stretch" : "center"}
          wrap="nowrap"
          style={isMobile ? { flexDirection: "column" } : undefined}
        >
          <Group
            gap="xs"
            wrap="nowrap"
            style={{ minWidth: 0, flex: 1, ...(isMobile ? { width: "100%" } : {}) }}
          >
            {dragHandle ?? (
              <MoveButtons
                entry={entry}
                csrfToken={csrfToken}
                isFirst={isFirst}
                isLast={isLast}
                formAction={formAction}
              />
            )}
            <Anchor
              component={Link}
              to={`/recipes/${entry.recipeId}`}
              prefetch="intent"
              fw={500}
              style={{
                ...(isMobile
                  ? { minWidth: 0, flex: 1 }
                  : {
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }),
              }}
            >
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
                onClick={() => submitTarget(target - 1)}
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
            </Group>
            <CookPicker
              entry={entry}
              members={members}
              effectiveCookId={effectiveCookId}
              submitCook={submitCook}
            />
            {showInlineAddNote ? (
              <NoteEditor
                entry={entry}
                csrfToken={csrfToken}
                formAction={formAction}
                compactWhenEmpty
              />
            ) : null}
          </Group>
        </Group>

        {!showInlineAddNote ? (
          <NoteEditor entry={entry} csrfToken={csrfToken} formAction={formAction} />
        ) : null}
      </Stack>

      <Modal
        opened={confirmRemove}
        onClose={closeConfirm}
        title="Remove from draft?"
        size="sm"
      >
        <Stack gap="sm">
          <Text size="sm">
            Remove <strong>{entry.recipeName}</strong> from the draft?
          </Text>
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={closeConfirm}>
              Cancel
            </Button>
            <Button
              color="red"
              onClick={confirmRemoveSubmit}
              aria-label={`Confirm remove ${entry.recipeName} from draft`}
            >
              Remove
            </Button>
          </Group>
        </Stack>
      </Modal>
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
  dragHandle,
}: {
  entry: KitchenEntry;
  csrfToken: string;
  members: KitchenMember[];
  isFirst: boolean;
  isLast: boolean;
  formAction?: string;
  dragHandle?: ReactNode;
}) {
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

  const [confirmCooked, { open: openCookedConfirm, close: closeCookedConfirm }] =
    useDisclosure(false);
  const flexFillStyle = { minWidth: 0, flex: 1 } as const;

  const cookedFetcher = useFetcher();
  const submitCooked = () => {
    const fd = new FormData();
    fd.set("intent", "mark-cooked");
    fd.set("instanceId", entry.id);
    fd.set(csrfFieldName(), csrfToken);
    cookedFetcher.submit(fd, {
      method: "post",
      ...(formAction ? { action: formAction } : {}),
    });
    closeCookedConfirm();
  };

  return (
    <Card withBorder padding="sm">
      <Stack gap="xs">
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0, width: "100%" }}>
          {dragHandle ?? (
            <MoveButtons
              entry={entry}
              csrfToken={csrfToken}
              isFirst={isFirst}
              isLast={isLast}
              formAction={formAction}
            />
          )}
          <Anchor
            component={Link}
            to={`/recipes/${entry.recipeId}`}
            prefetch="intent"
            fw={500}
            style={{
              ...flexFillStyle,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {entry.recipeName}
          </Anchor>
          <Text size="sm" c="dimmed">
            {entry.targetQuantity}
          </Text>
        </Group>
        <Group align="center" gap="xs" wrap="nowrap" style={{ width: "100%" }}>
          <CookPicker
            entry={entry}
            members={members}
            effectiveCookId={effectiveCookId}
            submitCook={submitCook}
          />
          <div style={flexFillStyle}>
            <NoteEditor
              entry={entry}
              csrfToken={csrfToken}
              formAction={formAction}
              compactWhenEmpty
            />
          </div>
          <ActionIcon
            type="button"
            variant="outline"
            color="green"
            size="sm"
            onClick={openCookedConfirm}
            aria-label={`Mark ${entry.recipeName} as cooked`}
          >
            ✓
          </ActionIcon>
        </Group>
      </Stack>

      <Modal
        opened={confirmCooked}
        onClose={closeCookedConfirm}
        title="Mark as cooked?"
        size="sm"
      >
        <Stack gap="sm">
          <Text size="sm">
            Mark <strong>{entry.recipeName}</strong> as cooked? This removes it
            from In stock.
          </Text>
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={closeCookedConfirm}>
              Cancel
            </Button>
            <Button
              type="button"
              color="green"
              onClick={submitCooked}
              aria-label={`Confirm mark ${entry.recipeName} as cooked`}
            >
              ✓ Cooked
            </Button>
          </Group>
        </Stack>
      </Modal>
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
  const navigation = useNavigation();
  const isFinalising =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "finalise";
  return (
    <>
      <Group justify="flex-end" mt="sm">
        <Button onClick={open} aria-label="Finalise draft" variant="subtle" size="xs">
          Finalise →
        </Button>
      </Group>
      <Modal
        opened={opened}
        onClose={close}
        title="Finalise this draft?"
        closeOnClickOutside={!isFinalising}
        closeOnEscape={!isFinalising}
        withCloseButton={!isFinalising}
      >
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
            <Button variant="default" onClick={close} disabled={isFinalising}>
              Cancel
            </Button>
            <Form method="post" action={formAction}>
              <CsrfField token={csrfToken} />
              <input type="hidden" name="intent" value="finalise" />
              <Button
                type="submit"
                aria-label="Confirm finalise draft"
                loading={isFinalising}
              >
                Finalise →
              </Button>
            </Form>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

function DragHandle({
  attributes,
  listeners,
  label,
}: {
  attributes: ReturnType<typeof useSortable>["attributes"];
  listeners: ReturnType<typeof useSortable>["listeners"];
  label: string;
}) {
  return (
    <ActionIcon
      variant="subtle"
      color="gray"
      size="sm"
      aria-label={label}
      {...attributes}
      {...listeners}
      style={{ cursor: "grab", touchAction: "none" }}
    >
      ⋮⋮
    </ActionIcon>
  );
}

function SortableRow({
  id,
  children,
}: {
  id: string;
  children: (handle: ReactNode) => ReactNode;
}) {
  const { setNodeRef, transform, transition, isDragging, attributes, listeners } =
    useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : 1,
      }}
    >
      {children(
        <DragHandle attributes={attributes} listeners={listeners} label="Reorder" />,
      )}
    </div>
  );
}

export function SortableLane({
  lane,
  entries,
  members,
  csrfToken,
  formAction,
}: {
  lane: Lane;
  entries: KitchenEntry[];
  members: KitchenMember[];
  csrfToken: string;
  formAction?: string;
}) {
  const serverOrder = entries.map((e) => e.id);
  const serverKey = serverOrder.join(",");
  const [override, setOverride] = useState<{ key: string; ids: string[] } | null>(
    null,
  );
  const order = override && override.key === serverKey ? override.ids : serverOrder;

  const fetcher = useFetcher();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 150, tolerance: 5 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const byId = new Map(entries.map((e) => [e.id, e]));
  const ordered = order.map((id) => byId.get(id)).filter(Boolean) as KitchenEntry[];

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = order.indexOf(String(active.id));
    const newIdx = order.indexOf(String(over.id));
    if (oldIdx < 0 || newIdx < 0) return;
    const next = arrayMove(order, oldIdx, newIdx);
    setOverride({ key: serverKey, ids: next });
    const fd = new FormData();
    fd.set("intent", "reorder");
    fd.set("lane", lane);
    fd.set("instanceIds", next.join(","));
    fd.set(csrfFieldName(), csrfToken);
    fetcher.submit(fd, {
      method: "post",
      ...(formAction ? { action: formAction } : {}),
    });
  };

  return (
    <DndContext
      id={`dnd-${lane}`}
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
    >
      <SortableContext items={order} strategy={verticalListSortingStrategy}>
        <Stack gap="xs">
          {ordered.map((entry, i) => (
            <SortableRow key={entry.id} id={entry.id}>
              {(handle) =>
                lane === "draft" ? (
                  <DraftCard
                    entry={entry}
                    csrfToken={csrfToken}
                    members={members}
                    isFirst={i === 0}
                    isLast={i === ordered.length - 1}
                    formAction={formAction}
                    dragHandle={handle}
                  />
                ) : (
                  <StockCard
                    entry={entry}
                    csrfToken={csrfToken}
                    members={members}
                    isFirst={i === 0}
                    isLast={i === ordered.length - 1}
                    formAction={formAction}
                    dragHandle={handle}
                  />
                )
              }
            </SortableRow>
          ))}
        </Stack>
      </SortableContext>
    </DndContext>
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
  // Layout intent: the sidebar as a whole scrolls when content overflows
  // the viewport. The two lanes flow naturally one after the other rather
  // than each owning its own scroll region.
  return (
    <Stack
      gap="md"
      component="aside"
      aria-label="Kitchen"
      style={{
        position: "sticky",
        top: "calc(var(--app-shell-header-height, 56px) + var(--mantine-spacing-md))",
        maxHeight:
          "calc(100vh - var(--app-shell-header-height, 56px) - 2 * var(--mantine-spacing-md))",
        overflowY: "auto",
      }}
    >
      <Stack gap="xs">
        <Title order={4}>
          Draft <Text span c="dimmed" inherit>{draft.length}</Text>
        </Title>
        {draft.length === 0 ? (
          <Text size="sm" c="dimmed">
            Draft is empty — add recipes from the collection.
          </Text>
        ) : (
          <SortableLane
            lane="draft"
            entries={draft}
            members={members}
            csrfToken={csrfToken}
            formAction={formAction}
          />
        )}
        {draft.length > 0 && (
          <FinaliseButton
            csrfToken={csrfToken}
            draft={draft}
            stockCount={stock.length}
            formAction={formAction}
          />
        )}
      </Stack>

      <Stack gap="xs">
        <Title order={4}>
          In stock <Text span c="dimmed" inherit>{stock.length}</Text>
        </Title>
        {stock.length === 0 ? (
          <Text size="sm" c="dimmed">
            Nothing in stock yet — finalise the draft to start cooking.
          </Text>
        ) : (
          <SortableLane
            lane="stock"
            entries={stock}
            members={members}
            csrfToken={csrfToken}
            formAction={formAction}
          />
        )}
      </Stack>
    </Stack>
  );
}
