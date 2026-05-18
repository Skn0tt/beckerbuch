import { useState } from "react";
import { Button, Group, Modal, Stack, Text, TextInput } from "@mantine/core";
import { useFetcher } from "react-router";
import { RecipeForm, type RecipeFormInitial } from "./recipe-form";

type ImportedPhoto = { contentType: string; base64: string };

type ImportResponse =
  | {
      ok: true;
      recipe: {
        name: string;
        baseQuantity: number;
        sourceUrl: string | null;
        steps: string;
        ingredients: Array<{ amount: string | null; unit: string | null; item: string }>;
        photo: ImportedPhoto | null;
      };
    }
  | { ok: false; error: string };

type Props = {
  csrfToken: string;
  error?: string;
};

/**
 * Wraps RecipeForm with a "Import from kptncook" button that opens a
 * modal. On a successful import the form fields are pre-filled and the
 * fetched photo is carried into the create action via a hidden base64
 * field.
 */
export function NewRecipeShell({ csrfToken, error }: Props) {
  const [opened, setOpened] = useState(false);
  const [input, setInput] = useState("");
  const [initial, setInitial] = useState<RecipeFormInitial | undefined>();
  const [importedPhoto, setImportedPhoto] = useState<ImportedPhoto | null>(null);
  const fetcher = useFetcher<ImportResponse>();
  const [formKey, setFormKey] = useState(0);
  const [consumedData, setConsumedData] = useState<ImportResponse | undefined>(
    undefined,
  );

  const importing = fetcher.state !== "idle";
  const fetcherError = fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;

  // React pattern "adjusting state during render": when a fresh
  // ImportResponse arrives, copy it into the form's initial state and
  // bump formKey so RecipeForm remounts. The `consumedData` state
  // guards against re-applying the same response on later renders.
  if (
    fetcher.state === "idle" &&
    fetcher.data &&
    fetcher.data !== consumedData
  ) {
    setConsumedData(fetcher.data);
    if (fetcher.data.ok) {
      const r = fetcher.data.recipe;
      setInitial({
        name: r.name,
        baseQuantity: r.baseQuantity,
        sourceUrl: r.sourceUrl ?? "",
        steps: r.steps,
        ingredients: r.ingredients.map((i) => ({
          amount: i.amount ?? "",
          unit: i.unit ?? "",
          item: i.item,
        })),
        photoUrl: r.photo
          ? `data:${r.photo.contentType};base64,${r.photo.base64}`
          : null,
      });
      setImportedPhoto(r.photo);
      setFormKey((k) => k + 1);
      setOpened(false);
      setInput("");
    }
  }

  return (
    <Stack gap="md">
      <Group justify="flex-end">
        <Button
          type="button"
          variant="light"
          onClick={() => setOpened(true)}
        >
          Import from kptncook
        </Button>
      </Group>

      <Modal
        opened={opened}
        onClose={() => {
          if (!importing) setOpened(false);
        }}
        title="Import a kptncook recipe"
        centered
      >
        <fetcher.Form method="post" action="/recipes/import-kptncook">
          <input type="hidden" name="_csrf" value={csrfToken} />
          <Stack gap="sm">
            <Text size="sm" c="dimmed">
              Paste a kptncook share URL (e.g. https://share.kptncook.com/…)
              or a recipe id. The fields below will be pre-filled; review
              and edit before saving.
            </Text>
            <TextInput
              name="input"
              label="Share URL or id"
              placeholder="https://share.kptncook.com/abcd1234"
              value={input}
              onChange={(e) => setInput(e.currentTarget.value)}
              required
              autoFocus
              data-autofocus
            />
            {fetcherError && (
              <Text size="sm" c="red" role="alert">
                {fetcherError}
              </Text>
            )}
            <Group justify="flex-end">
              <Button
                type="button"
                variant="default"
                onClick={() => setOpened(false)}
                disabled={importing}
              >
                Cancel
              </Button>
              <Button type="submit" loading={importing} disabled={!input.trim()}>
                Import
              </Button>
            </Group>
          </Stack>
        </fetcher.Form>
      </Modal>

      <RecipeForm
        key={formKey}
        csrfToken={csrfToken}
        initial={initial}
        error={error}
        submitLabel="Save recipe"
        hiddenExtras={
          importedPhoto ? (
            <input
              type="hidden"
              name="importedPhotoB64"
              value={`${importedPhoto.contentType};${importedPhoto.base64}`}
            />
          ) : null
        }
      />
    </Stack>
  );
}
