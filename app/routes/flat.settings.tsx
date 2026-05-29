import {
  Alert,
  Anchor,
  Button,
  Container,
  CopyButton,
  Group,
  Loader,
  List,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { useEffect, useRef, useState, type FocusEvent } from "react";
import { Form, redirect, useActionData, useNavigation } from "react-router";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Route } from "./+types/flat.settings";
import { db } from "../db/client";
import { flatMembers, invites, users } from "../db/schema";
import { requireFlatMember } from "../auth/require";
import { requireCsrf, csrfTokenForSession } from "../auth/csrf.server";
import { isSameOrigin } from "../auth/origin";
import { CsrfField } from "../auth/csrf-field";
import { generateInviteToken } from "../auth/invite";
import { UserAvatar } from "../components/user-avatar";
import { deleteAvatar, storeAvatar, validateAvatar } from "../lib/avatars";
import { firstMessage, formDataToObject } from "../lib/form";

const ActionSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("rotate-invite") }),
  z.object({
    intent: z.literal("upload-avatar"),
    avatar: z
      .instanceof(File, { message: "Please choose an image file." })
      .refine((f) => f.size > 0, "Please choose an image file."),
  }),
  z.object({
    intent: z.literal("update-display-name"),
    displayName: z
      .string()
      .trim()
      .min(1, "Display name 1–80 chars.")
      .max(80, "Display name 1–80 chars."),
  }),
  z.object({ intent: z.literal("remove-avatar") }),
]);

type Member = {
  id: string;
  email: string;
  displayName: string;
  avatarKey: string | null;
};
type CurrentInvite = { token: string; createdAt: Date } | null;

async function listMembers(flatId: string): Promise<Member[]> {
  return db()
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      avatarKey: users.avatarBlobKey,
    })
    .from(flatMembers)
    .innerJoin(users, eq(users.id, flatMembers.userId))
    .where(eq(flatMembers.flatId, flatId))
    .orderBy(flatMembers.joinedAt);
}

async function getCurrentInvite(flatId: string): Promise<CurrentInvite> {
  const [row] = await db()
    .select({ token: invites.token, createdAt: invites.createdAt })
    .from(invites)
    .where(
      and(
        eq(invites.flatId, flatId),
        isNull(invites.usedAt),
        or(isNull(invites.expiresAt), sql`${invites.expiresAt} > now()`),
      ),
    )
    .orderBy(sql`${invites.createdAt} desc`)
    .limit(1);
  return row ?? null;
}

export async function loader({ request }: Route.LoaderArgs) {
  const ctx = await requireFlatMember(request);
  const [members, currentInvite, [userRow]] = await Promise.all([
    listMembers(ctx.flat.id),
    getCurrentInvite(ctx.flat.id),
    db()
      .select({ mcpToken: users.mcpToken })
      .from(users)
      .where(eq(users.id, ctx.user.id))
      .limit(1),
  ]);
  return {
    flat: ctx.flat,
    user: {
      id: ctx.user.id,
      displayName: ctx.user.displayName,
      avatarKey: (members.find((m) => m.id === ctx.user.id)?.avatarKey ?? null),
      mcpToken: userRow?.mcpToken ?? "",
    },
    csrfToken: csrfTokenForSession(ctx.session.id),
    members,
    currentInvite,
    origin: new URL(request.url).origin,
  };
}

export async function action({ request }: Route.ActionArgs) {
  if (!isSameOrigin(request)) {
    throw new Response("Bad origin.", { status: 403 });
  }
  const ctx = await requireFlatMember(request);
  await requireCsrf(request, ctx.session.id);

  const form = await request.formData();
  const parsed = ActionSchema.safeParse(formDataToObject(form));
  if (!parsed.success) {
    return { error: firstMessage(parsed.error) };
  }

  if (parsed.data.intent === "rotate-invite") {
    await db().transaction(async (tx) => {
      // Expire all current usable invites for this flat.
      await tx
        .update(invites)
        .set({ expiresAt: sql`now()` })
        .where(
          and(
            eq(invites.flatId, ctx.flat.id),
            isNull(invites.usedAt),
            or(isNull(invites.expiresAt), sql`${invites.expiresAt} > now()`),
          ),
        );
      await tx.insert(invites).values({
        token: generateInviteToken(),
        flatId: ctx.flat.id,
        createdBy: ctx.user.id,
      });
    });

    return redirect("/flat/settings");
  }

  const [me] = await db()
    .select({ avatarBlobKey: users.avatarBlobKey })
    .from(users)
    .where(eq(users.id, ctx.user.id))
    .limit(1);
  if (!me) throw new Response("User not found", { status: 404 });

  if (parsed.data.intent === "upload-avatar") {
    const avatarFile = parsed.data.avatar;
    const v = validateAvatar(avatarFile);
    if (!v.ok) return { error: v.error };

    if (me.avatarBlobKey) await deleteAvatar(me.avatarBlobKey);
    const nextKey = await storeAvatar(ctx.user.id, avatarFile, v.contentType);
    await db()
      .update(users)
      .set({ avatarBlobKey: nextKey })
      .where(eq(users.id, ctx.user.id));
    return redirect("/flat/settings");
  }
  if (parsed.data.intent === "update-display-name") {
    await db()
      .update(users)
      .set({ displayName: parsed.data.displayName })
      .where(eq(users.id, ctx.user.id));
    return redirect("/flat/settings");
  }

  // remove-avatar
  if (me.avatarBlobKey) await deleteAvatar(me.avatarBlobKey);
  await db()
    .update(users)
    .set({ avatarBlobKey: null })
    .where(eq(users.id, ctx.user.id));
  return redirect("/flat/settings");
}

export default function FlatSettings({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<{ error?: string } | undefined>();
  const navigation = useNavigation();
  const { members, currentInvite, origin, csrfToken, user } = loaderData;
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const [isEditingName, setIsEditingName] = useState(false);
  const [displayNameDraft, setDisplayNameDraft] = useState(user.displayName);
  useEffect(() => {
    if (!isEditingName || !nameInputRef.current) return;
    nameInputRef.current.focus();
    nameInputRef.current.select();
  }, [isEditingName]);
  const inviteUrl = currentInvite
    ? `${origin}/invite/${currentInvite.token}`
    : null;
  const mcpUrl = `${origin}/mcp?token=${user.mcpToken}`;
  const isAvatarUploading =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "upload-avatar";

  const saveDisplayNameIfChanged = (e: FocusEvent<HTMLInputElement>) => {
    const form = e.currentTarget.form;
    if (!form) return;
    const next = displayNameDraft.trim();
    if (!next || next === user.displayName) {
      setDisplayNameDraft(user.displayName);
      setIsEditingName(false);
      return;
    }
    form.requestSubmit();
    setIsEditingName(false);
  };

  return (
    <Container size={520} py="xl">
      <Stack gap="lg">
        <section>
          <Title order={4} mb="xs">
            Profile
          </Title>
          <Stack gap="xs">
            <Group gap="sm">
              <Form method="post" encType="multipart/form-data">
                <CsrfField token={csrfToken} />
                <input type="hidden" name="intent" value="upload-avatar" />
                <input
                  ref={avatarInputRef}
                  type="file"
                  name="avatar"
                  accept="image/png,image/jpeg,image/webp"
                  aria-label="Profile picture"
                  style={{ display: "none" }}
                  onChange={(e) => e.currentTarget.form?.requestSubmit()}
                />
                <UnstyledButton
                  type="button"
                  aria-label="Change profile picture"
                  aria-busy={isAvatarUploading}
                  disabled={isAvatarUploading}
                  onClick={() => avatarInputRef.current?.click()}
                  style={{ borderRadius: "50%", display: "inline-flex", position: "relative" }}
                >
                  <UserAvatar user={user} />
                  {isAvatarUploading ? (
                    <span
                      style={{
                        position: "absolute",
                        inset: 0,
                        borderRadius: "50%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        background: "rgba(255, 255, 255, 0.6)",
                      }}
                    >
                      <Loader size="xs" aria-label="Uploading profile picture" />
                    </span>
                  ) : null}
                </UnstyledButton>
              </Form>
              {isEditingName ? (
                <Form method="post" style={{ flex: 1 }}>
                  <CsrfField token={csrfToken} />
                  <input type="hidden" name="intent" value="update-display-name" />
                  <TextInput
                    ref={nameInputRef}
                    name="displayName"
                    aria-label="Display name"
                    size="md"
                    value={displayNameDraft}
                    onChange={(e) => setDisplayNameDraft(e.currentTarget.value)}
                    onBlur={saveDisplayNameIfChanged}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setDisplayNameDraft(user.displayName);
                        setIsEditingName(false);
                      }
                    }}
                  />
                </Form>
              ) : (
                <UnstyledButton
                  type="button"
                  onClick={() => {
                    setDisplayNameDraft(user.displayName);
                    setIsEditingName(true);
                  }}
                  style={{ textAlign: "left", flex: 1 }}
                >
                  <Text size="lg" fw={500}>
                    {user.displayName}
                  </Text>
                </UnstyledButton>
              )}
            </Group>
            {actionData?.error ? <Alert color="red">{actionData.error}</Alert> : null}
          </Stack>
        </section>

        <section>
          <Title order={4} mb="xs">
            Members
          </Title>
          <List spacing={4} listStyleType="none" withPadding={false}>
            {members.map((m) => (
              <List.Item key={m.id}>
                <Group gap="sm" wrap="nowrap">
                  <UserAvatar user={m} size="sm" />
                  <Text>
                    <strong>{m.displayName}</strong>{" "}
                    <Text component="span" c="dimmed" size="sm">
                      {m.email}
                    </Text>
                  </Text>
                </Group>
              </List.Item>
            ))}
          </List>
        </section>

        <section>
          <Title order={4} mb="xs">
            Invite
          </Title>
          {inviteUrl ? (
            <Stack gap="xs">
              <Paper withBorder p="xs">
                <Group justify="space-between" wrap="nowrap" gap="xs">
                  <TextInput
                    value={inviteUrl}
                    readOnly
                    style={{ flex: 1 }}
                    aria-label="Invite link"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <CopyButton value={inviteUrl}>
                    {({ copied, copy }) => (
                      <Button
                        variant="light"
                        onClick={copy}
                        size="sm"
                        type="button"
                      >
                        {copied ? "Copied" : "Copy"}
                      </Button>
                    )}
                  </CopyButton>
                </Group>
              </Paper>
              <Text c="dimmed" size="sm">
                Anyone with this link can join your flat.
              </Text>
            </Stack>
          ) : (
            <Text c="dimmed" size="sm">
              No active invite link. Generate one to invite someone.
            </Text>
          )}
          <Form method="post" style={{ marginTop: "var(--mantine-spacing-sm)" }}>
            <CsrfField token={csrfToken} />
            <input type="hidden" name="intent" value="rotate-invite" />
            <Button type="submit" variant="default">
              {inviteUrl ? "Generate new link" : "Generate link"}
            </Button>
          </Form>
        </section>

        <section>
          <Title order={4} mb="xs">
            Account
          </Title>
          <Form method="post" action="/logout">
            <CsrfField token={csrfToken} />
            <Button type="submit" variant="default" color="red">
              Sign out
            </Button>
          </Form>
        </section>

        <section>
          <Title order={4} mb="xs">
            MCP
          </Title>
          <Stack gap="xs">
            <Paper withBorder p="xs">
              <Group justify="space-between" wrap="nowrap" gap="xs">
                <TextInput
                  value={mcpUrl}
                  readOnly
                  style={{ flex: 1 }}
                  aria-label="MCP URL"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <CopyButton value={mcpUrl}>
                  {({ copied, copy }) => (
                    <Button
                      variant="light"
                      onClick={copy}
                      size="sm"
                      type="button"
                    >
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  )}
                </CopyButton>
              </Group>
            </Paper>
            <Text c="dimmed" size="sm">
              Use this URL to add cookbook as a custom connector in{" "}
              <Anchor
                href="https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp"
                target="_blank"
                rel="noopener noreferrer"
              >
                Claude
              </Anchor>
              .
            </Text>
          </Stack>
        </section>

        <section>
          <Title order={4} mb="xs">
            About
          </Title>
          <Text size="sm">
            <Anchor
              href="https://github.com/Skn0tt/beckerbuch"
              target="_blank"
              rel="noopener noreferrer"
            >
              Source code on GitHub
            </Anchor>
          </Text>
        </section>
      </Stack>
    </Container>
  );
}
