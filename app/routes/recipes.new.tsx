import { Anchor, Container, Group, Stack, Title } from "@mantine/core";
import { Link, redirect, useActionData } from "react-router";
import type { Route } from "./+types/recipes.new";
import { requireFlatMember } from "../auth/require";
import { requireCsrf, csrfTokenForSession } from "../auth/csrf.server";
import { isSameOrigin } from "../auth/origin";
import { parseRecipeFields } from "../components/recipe-form";
import { NewRecipeShell } from "../components/new-recipe-shell";
import { validatePhoto, validatePhotoBytes } from "../blobs";
import { createRecipe } from "../lib/recipes";

export async function loader({ request }: Route.LoaderArgs) {
  const ctx = await requireFlatMember(request);
  return { csrfToken: csrfTokenForSession(ctx.session.id) };
}

export async function action({ request }: Route.ActionArgs) {
  if (!isSameOrigin(request)) {
    throw new Response("Bad origin.", { status: 403 });
  }
  const ctx = await requireFlatMember(request);
  await requireCsrf(request, ctx.session.id);

  const form = await request.formData();
  const parsed = parseRecipeFields(form);
  if (!parsed.ok) return { error: parsed.error };

  let photo: { bytes: Uint8Array; contentType: string } | undefined;

  // A file pick beats the kptncook-imported photo if both are present.
  const photoFile = form.get("photo");
  if (photoFile instanceof File && photoFile.size > 0) {
    const v = validatePhoto(photoFile);
    if (!v.ok) return { error: v.error };
    photo = {
      bytes: new Uint8Array(await photoFile.arrayBuffer()),
      contentType: v.contentType,
    };
  } else {
    const imported = form.get("importedPhotoB64");
    if (typeof imported === "string" && imported.length > 0) {
      const sepIdx = imported.indexOf(";");
      if (sepIdx > 0) {
        const contentType = imported.slice(0, sepIdx);
        const b64 = imported.slice(sepIdx + 1);
        try {
          const bytes = new Uint8Array(Buffer.from(b64, "base64"));
          const v = validatePhotoBytes(bytes.byteLength, contentType);
          if (!v.ok) return { error: v.error };
          photo = { bytes, contentType: v.contentType };
        } catch {
          // Drop a corrupt imported photo rather than failing the save.
        }
      }
    }
  }

  const { id } = await createRecipe({
    flatId: ctx.flat.id,
    ...parsed.fields,
    ingredients: parsed.ingredients,
    photo,
  });

  return redirect(`/recipes/${id}`);
}

export default function NewRecipe({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<{ error?: string } | undefined>();
  return (
    <Container size="sm" py="xl">
      <Stack gap="md">
        <Group justify="space-between" align="center">
          <Title order={2}>New recipe</Title>
          <Anchor component={Link} to="/" prefetch="intent">← Cancel</Anchor>
        </Group>
        <NewRecipeShell
          csrfToken={loaderData.csrfToken}
          error={actionData?.error}
        />
      </Stack>
    </Container>
  );
}
