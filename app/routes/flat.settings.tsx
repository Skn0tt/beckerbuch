import {
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
import { Form, Link, redirect } from "react-router";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { Route } from "./+types/flat.settings";
import { db } from "../db/client";
import { flatMembers, invites, users } from "../db/schema";
import { requireFlatMember } from "../auth/require";
import { requireCsrf, csrfTokenForSession } from "../auth/csrf.server";
import { isSameOrigin } from "../auth/origin";
import { CsrfField } from "../auth/csrf-field";
import { generateInviteToken } from "../auth/invite";

type Member = { id: string; email: string; displayName: string };
type CurrentInvite = { token: string; createdAt: Date } | null;

async function listMembers(flatId: string): Promise<Member[]> {
  return db()
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
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
  const intent = form.get("intent");
  if (intent !== "rotate-invite") {
    throw new Response("Unknown intent", { status: 400 });
  }

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

export default function FlatSettings({ loaderData }: Route.ComponentProps) {
  const { flat, members, currentInvite, origin, csrfToken } = loaderData;
  const inviteUrl = currentInvite
    ? `${origin}/invite/${currentInvite.token}`
    : null;

  return (
    <Container size={520} py="xl">
      <Stack gap="lg">
        <Group justify="space-between" align="center">
          <Title order={2}>Flat: {flat.name}</Title>
          <Anchor component={Link} to="/">← Back</Anchor>
        </Group>

        <section>
          <Title order={4} mb="xs">
            Members
          </Title>
          <List spacing={4} listStyleType="none" withPadding={false}>
            {members.map((m) => (
              <List.Item key={m.id}>
                <Text>
                  <strong>{m.displayName}</strong>{" "}
                  <Text component="span" c="dimmed" size="sm">
                    {m.email}
                  </Text>
                </Text>
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
      </Stack>
    </Container>
  );
}
