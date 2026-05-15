import {
  Alert,
  Anchor,
  Button,
  Container,
  PasswordInput,
  Stack,
  TextInput,
  Title,
} from "@mantine/core";
import { Form, redirectDocument, useSearchParams } from "react-router";
import { eq } from "drizzle-orm";
import type { Route } from "./+types/login";
import { db } from "../db/client";
import { users, sessions } from "../db/schema";
import {
  buildSetSessionCookie,
  createSessionToken,
  hashSessionToken,
} from "../auth/session";
import { tryGetAuthedContext } from "../auth/require";
import { getDummyHash, verifyPassword } from "../auth/password";
import {
  checkLoginRateLimit,
  clearLoginAttempts,
  recordLoginFailure,
} from "../auth/rate-limit";
import { safeRedirectTarget } from "../auth/safe-redirect";

export async function loader({ request }: Route.LoaderArgs) {
  const ctx = await tryGetAuthedContext(request);
  if (ctx) throw redirectDocument("/");
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  const redirectTo = safeRedirectTarget(String(form.get("redirect") ?? "/"));

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  const limit = checkLoginRateLimit(email);
  if (!limit.allowed) {
    return {
      error: `Too many attempts. Try again in ${Math.ceil(limit.retryAfterMs / 60000)} minute(s).`,
    };
  }

  const d = db();
  const [user] = await d
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  // Always run argon2 verify — against a dummy hash if the user doesn't
  // exist — so response time doesn't reveal account existence.
  const ok = user
    ? await verifyPassword(user.passwordHash, password)
    : (await verifyPassword(await getDummyHash(), password), false);

  if (!ok || !user) {
    recordLoginFailure(email);
    return { error: "Invalid email or password." };
  }

  clearLoginAttempts(email);

  const token = createSessionToken();
  await d.insert(sessions).values({ id: hashSessionToken(token), userId: user.id });

  return redirectDocument(redirectTo, {
    headers: { "Set-Cookie": buildSetSessionCookie(token) },
  });
}

export default function Login({ actionData }: Route.ComponentProps) {
  const [searchParams] = useSearchParams();
  const redirectTo = safeRedirectTarget(searchParams.get("redirect"));

  return (
    <Container size={420} py="xl">
      <Stack gap="md">
        <Title order={2}>Sign in</Title>
        <Form method="post">
          <Stack gap="sm">
            <input type="hidden" name="redirect" value={redirectTo} />
            <TextInput
              name="email"
              type="email"
              label="Email"
              autoComplete="username"
              required
            />
            <PasswordInput
              name="password"
              label="Password"
              autoComplete="current-password"
              required
            />
            {actionData?.error && (
              <Alert color="red" role="alert">
                {actionData.error}
              </Alert>
            )}
            <Button type="submit">Sign in</Button>
            <Anchor component="a" href="#" size="sm" c="dimmed">
              Got an invite? Open the invite link.
            </Anchor>
          </Stack>
        </Form>
      </Stack>
    </Container>
  );
}
