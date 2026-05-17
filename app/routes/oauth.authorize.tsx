import {
  Alert,
  Anchor,
  Button,
  Card,
  Container,
  Group,
  List,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { Form, redirect } from "react-router";
import type { Route } from "./+types/oauth.authorize";
import { tryGetAuthedContext } from "../auth/require";
import { csrfTokenForSession, requireCsrf } from "../auth/csrf.server";
import { CsrfField } from "../auth/csrf-field";
import { isSameOrigin } from "../auth/origin";
import {
  SUPPORTED_SCOPE,
  getClient,
  issueAuthorizationCode,
} from "../auth/oauth";

type AuthorizeParams = {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scope: string;
};

type ParamResult =
  | { ok: true; params: AuthorizeParams }
  | { ok: false; status: number; message: string };

function parseParams(url: URL): ParamResult {
  const clientId = url.searchParams.get("client_id") ?? "";
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const responseType = url.searchParams.get("response_type") ?? "";
  const codeChallenge = url.searchParams.get("code_challenge") ?? "";
  const codeChallengeMethod =
    url.searchParams.get("code_challenge_method") ?? "";
  const scope = url.searchParams.get("scope") ?? SUPPORTED_SCOPE;

  if (!clientId || !redirectUri) {
    return {
      ok: false,
      status: 400,
      message: "client_id and redirect_uri are required.",
    };
  }
  if (responseType !== "code") {
    return {
      ok: false,
      status: 400,
      message: "response_type must be 'code'.",
    };
  }
  if (!codeChallenge || codeChallengeMethod !== "S256") {
    return {
      ok: false,
      status: 400,
      message: "PKCE with code_challenge_method=S256 is required.",
    };
  }
  if (scope !== SUPPORTED_SCOPE) {
    return {
      ok: false,
      status: 400,
      message: `Only scope '${SUPPORTED_SCOPE}' is supported.`,
    };
  }

  return {
    ok: true,
    params: { clientId, redirectUri, state, codeChallenge, scope },
  };
}

function buildRedirect(
  redirectUri: string,
  fields: Record<string, string>,
): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(fields)) u.searchParams.set(k, v);
  return u.toString();
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const parsed = parseParams(url);
  if (!parsed.ok) {
    throw new Response(parsed.message, { status: parsed.status });
  }
  const { params } = parsed;

  const client = await getClient(params.clientId);
  if (!client) {
    throw new Response("Unknown client.", { status: 400 });
  }
  if (!client.redirectUris.includes(params.redirectUri)) {
    throw new Response("redirect_uri not registered for this client.", {
      status: 400,
    });
  }

  const ctx = await tryGetAuthedContext(request);
  if (!ctx) {
    const target = url.pathname + url.search;
    throw redirect(`/login?redirect=${encodeURIComponent(target)}`);
  }

  return {
    clientName: client.clientName,
    flatName: ctx.flat.name,
    scope: params.scope,
    csrfToken: csrfTokenForSession(ctx.session.id),
    // Echo the raw query params back into the form so they're re-submitted.
    queryString: url.searchParams.toString(),
  };
}

export async function action({ request }: Route.ActionArgs) {
  if (!isSameOrigin(request)) {
    throw new Response("Bad origin.", { status: 403 });
  }
  const ctx = await tryGetAuthedContext(request);
  if (!ctx) throw new Response("Unauthorized", { status: 401 });
  await requireCsrf(request, ctx.session.id);

  const form = await request.formData();
  const decision = String(form.get("decision") ?? "");

  // Re-parse the OAuth params from the hidden form field.
  const rawQs = String(form.get("query_string") ?? "");
  const url = new URL(`http://placeholder/?${rawQs}`);
  const parsed = parseParams(url);
  if (!parsed.ok) {
    throw new Response("Invalid OAuth params.", { status: 400 });
  }
  const { params } = parsed;

  const client = await getClient(params.clientId);
  if (!client || !client.redirectUris.includes(params.redirectUri)) {
    throw new Response("Unknown client / redirect_uri.", { status: 400 });
  }

  if (decision !== "approve") {
    throw redirect(
      buildRedirect(params.redirectUri, {
        error: "access_denied",
        state: params.state,
      }),
    );
  }

  const code = await issueAuthorizationCode({
    clientId: params.clientId,
    userId: ctx.user.id,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
    scope: params.scope,
  });

  throw redirect(
    buildRedirect(params.redirectUri, { code, state: params.state }),
  );
}

export default function Authorize({ loaderData }: Route.ComponentProps) {
  return (
    <Container size={520} py="xl">
      <Stack gap="md">
        <Title order={2}>Authorize access</Title>
        <Card withBorder padding="lg">
          <Stack gap="sm">
            <Text>
              <Text span fw={600}>
                {loaderData.clientName}
              </Text>{" "}
              wants to access your flat{" "}
              <Text span fw={600}>
                {loaderData.flatName}
              </Text>
              .
            </Text>
            <Text size="sm" c="dimmed">
              It will be allowed to:
            </Text>
            <List size="sm">
              <List.Item>Add and edit recipes</List.Item>
            </List>
            <Alert color="yellow" variant="light">
              Only approve clients you trust. They will be able to act on your
              behalf until you revoke access.
            </Alert>
            <Form method="post">
              <CsrfField token={loaderData.csrfToken} />
              <input
                type="hidden"
                name="query_string"
                value={loaderData.queryString}
              />
              <Group justify="flex-end" mt="sm">
                <Button
                  type="submit"
                  name="decision"
                  value="deny"
                  variant="default"
                >
                  Deny
                </Button>
                <Button type="submit" name="decision" value="approve">
                  Approve
                </Button>
              </Group>
            </Form>
            <Anchor href="/" size="xs" c="dimmed">
              Cancel and return home
            </Anchor>
          </Stack>
        </Card>
      </Stack>
    </Container>
  );
}
