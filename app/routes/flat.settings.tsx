import {
  Alert,
  Anchor,
  Button,
  Container,
  CopyButton,
  Group,
  List,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { Form, redirect, useActionData } from "react-router";
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
  const [members, currentInvite] = await Promise.all([
    listMembers(ctx.flat.id),
    getCurrentInvite(ctx.flat.id),
  ]);
  return {
    flat: ctx.flat,
    user: {
      id: ctx.user.id,
      displayName: ctx.user.displayName,
      avatarKey: (members.find((m) => m.id === ctx.user.id)?.avatarKey ?? null),
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
  const { members, currentInvite, origin, csrfToken, user } = loaderData;
  const inviteUrl = currentInvite
    ? `${origin}/invite/${currentInvite.token}`
    : null;
  const mcpUrl = `${origin}/mcp`;

  return (
    <Container size={520} py="xl">
      <Stack gap="lg">
        <section>
          <Title order={4} mb="xs">
            Profile
          </Title>
          <Stack gap="xs">
            <Group gap="sm">
              <UserAvatar user={user} />
              <Text size="sm" c="dimmed">
                {user.displayName}
              </Text>
            </Group>
            {actionData?.error ? <Alert color="red">{actionData.error}</Alert> : null}
            <Form method="post" encType="multipart/form-data">
              <Stack gap="xs">
                <CsrfField token={csrfToken} />
                <input type="hidden" name="intent" value="upload-avatar" />
                <Text size="sm" fw={500}>
                  Profile picture
                </Text>
                <input
                  type="file"
                  name="avatar"
                  aria-label="Profile picture"
                  accept="image/png,image/jpeg,image/webp"
                />
                <Group>
                  <Button type="submit" variant="default">
                    Upload
                  </Button>
                </Group>
              </Stack>
            </Form>
            {user.avatarKey ? (
              <Form method="post">
                <CsrfField token={csrfToken} />
                <input type="hidden" name="intent" value="remove-avatar" />
                <Button type="submit" variant="subtle" color="red">
                  Remove picture
                </Button>
              </Form>
            ) : null}
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
