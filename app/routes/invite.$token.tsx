import {
  Alert,
  Button,
  Container,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { Form, redirectDocument, data, useNavigation } from "react-router";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { Route } from "./+types/invite.$token";
import { db } from "../db/client";
import { flatMembers, flats, invites, sessions, users } from "../db/schema";
import { tryGetAuthedContext } from "../auth/require";
import {
  buildSetSessionCookie,
  createSessionToken,
  hashSessionToken,
} from "../auth/session";
import {
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_BYTES,
  hashPassword,
} from "../auth/password";
import { isBlockedPassword } from "../auth/blocklist";
import { isSameOrigin } from "../auth/origin";

type InviteRow = {
  token: string;
  flatId: string;
  flatName: string;
};

async function findUsableInvite(token: string): Promise<InviteRow | null> {
  const [row] = await db()
    .select({
      token: invites.token,
      flatId: invites.flatId,
      flatName: flats.name,
    })
    .from(invites)
    .innerJoin(flats, eq(flats.id, invites.flatId))
    .where(
      and(
        eq(invites.token, token),
        isNull(invites.usedAt),
        or(isNull(invites.expiresAt), sql`${invites.expiresAt} > now()`),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const ctx = await tryGetAuthedContext(request);
  const invite = await findUsableInvite(params.token);
  if (!invite) {
    throw data("Invite not found or already used.", { status: 404 });
  }
  if (ctx) {
    // Logged-in users can't redeem a second flat (one-flat-per-user).
    return { mode: "already-member" as const, invite, currentFlat: ctx.flat };
  }
  return { mode: "signup" as const, invite };
}

export async function action({ request, params }: Route.ActionArgs) {
  if (!isSameOrigin(request)) {
    throw data("Bad origin.", { status: 403 });
  }

  const ctx = await tryGetAuthedContext(request);
  if (ctx) {
    throw data("You are already in a flat.", { status: 403 });
  }

  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const displayName = String(form.get("displayName") ?? "").trim();
  const password = String(form.get("password") ?? "");

  const errors: { field: string; message: string }[] = [];
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push({ field: "email", message: "Enter a valid email." });
  }
  if (!displayName || displayName.length > 80) {
    errors.push({ field: "displayName", message: "Display name 1–80 chars." });
  }
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    errors.push({ field: "password", message: "Password too long." });
  } else if (password.length < MIN_PASSWORD_LENGTH) {
    errors.push({
      field: "password",
      message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    });
  } else if (isBlockedPassword(password)) {
    errors.push({ field: "password", message: "Password is too common." });
  }
  if (errors.length > 0) {
    return { errors };
  }

  const passwordHash = await hashPassword(password);
  const sessionToken = createSessionToken();
  const sessionId = hashSessionToken(sessionToken);

  try {
    await db().transaction(async (tx) => {
      // Lock the invite row first. If anyone else already used it, this
      // returns nothing and we abort — guaranteeing the invite drives the
      // signup, not the user-insert succeeding.
      const [claimed] = await tx
        .select({ flatId: invites.flatId })
        .from(invites)
        .where(
          and(
            eq(invites.token, params.token),
            isNull(invites.usedAt),
            or(isNull(invites.expiresAt), sql`${invites.expiresAt} > now()`),
          ),
        )
        .for("update")
        .limit(1);
      if (!claimed) {
        throw new InviteUnusableError();
      }

      let userId: string;
      try {
        const [user] = await tx
          .insert(users)
          .values({ email, passwordHash, displayName })
          .returning({ id: users.id });
        userId = user.id;
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw new EmailTakenError();
        }
        throw e;
      }

      await tx.insert(flatMembers).values({
        flatId: claimed.flatId,
        userId,
      });

      await tx
        .update(invites)
        .set({ usedBy: userId, usedAt: sql`now()` })
        .where(eq(invites.token, params.token));

      await tx.insert(sessions).values({ id: sessionId, userId });
    });
  } catch (e) {
    if (e instanceof InviteUnusableError) {
      throw data("Invite no longer valid.", { status: 410 });
    }
    if (e instanceof EmailTakenError) {
      return {
        errors: [{ field: "email", message: "An account with that email already exists." }],
      };
    }
    throw e;
  }

  return redirectDocument("/", {
    headers: { "Set-Cookie": buildSetSessionCookie(sessionToken) },
  });
}

class InviteUnusableError extends Error {}
class EmailTakenError extends Error {}

function isUniqueViolation(e: unknown): boolean {
  // Drizzle wraps the pg error in a DrizzleQueryError; the original lives
  // on .cause. Walk the cause chain to find code 23505.
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    if (
      typeof cur === "object" &&
      cur !== null &&
      "code" in cur &&
      (cur as { code?: string }).code === "23505"
    ) {
      return true;
    }
    cur =
      typeof cur === "object" && cur !== null && "cause" in cur
        ? (cur as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}

export default function InvitePage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const navigation = useNavigation();
  const isCreating = navigation.state !== "idle";

  if (loaderData.mode === "already-member") {
    return (
      <Container size={460} py="xl">
        <Stack gap="md">
          <Title order={2}>You&rsquo;re already in a flat</Title>
          <Text>
            You&rsquo;re currently a member of <strong>{loaderData.currentFlat.name}</strong>.
            Cookbook only supports one flat per account.
          </Text>
          <Text c="dimmed" size="sm">
            Ask the inviter to use a different account, or sign out first.
          </Text>
        </Stack>
      </Container>
    );
  }

  const errorsByField = new Map(
    actionData?.errors?.map((e) => [e.field, e.message] as const) ?? [],
  );

  return (
    <Container size={460} py="xl">
      <Stack gap="md">
        <Title order={2}>Join {loaderData.invite.flatName}</Title>
        <Text c="dimmed">Create an account to join this flat&rsquo;s cookbook.</Text>
        <Form method="post">
          <Stack gap="sm">
            <TextInput
              name="email"
              type="email"
              label="Email"
              autoComplete="email"
              required
              error={errorsByField.get("email")}
            />
            <TextInput
              name="displayName"
              label="Display name"
              autoComplete="name"
              required
              error={errorsByField.get("displayName")}
            />
            <PasswordInput
              name="password"
              label="Password"
              description={`Min ${MIN_PASSWORD_LENGTH} characters.`}
              autoComplete="new-password"
              required
              error={errorsByField.get("password")}
            />
            {actionData?.errors && actionData.errors.length > 1 && (
              <Alert color="red" role="alert">
                Please fix the errors above.
              </Alert>
            )}
            <Button type="submit" loading={isCreating} disabled={isCreating}>Create account &amp; join</Button>
          </Stack>
        </Form>
      </Stack>
    </Container>
  );
}
