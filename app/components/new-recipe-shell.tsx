import { memo, useCallback, useState } from "react";
import { Button, Group, Input, Modal, Stack, Text } from "@mantine/core";
import { useFetcher } from "react-router";
import {
  recipeUrlFromClipboard,
  recipeUrlFromClipboardData,
} from "../lib/recipe-url";
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
 * Contenteditable, not `<input>`. Pasting into a text field forces
 * plain text, and Safari then drops the hyperlink KptnCook hung on
 * the share sentence. A contenteditable keeps that `<a href>`, and
 * the paste event's other clipboard flavors (HTML, URI list) cover
 * browsers that do expose them.
 *
 * Memoized so parent state updates don't reconcile the element and
 * wipe what the user pasted.
 */
const ImportLinkField = memo(function ImportLinkField({
  onValue,
}: {
  onValue: (value: string) => void;
}) {
  function commit(el: HTMLElement, next: string) {
    if ((el.textContent ?? "") !== next) el.textContent = next;
    onValue(next);
  }

  return (
    <Input.Wrapper label="Recipe URL or kptncook link / id" required>
      <Input
        component="div"
        contentEditable
        role="textbox"
        aria-multiline={false}
        aria-label="Recipe URL or kptncook link / id"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        data-autofocus
        data-recipe-link-field
        data-placeholder="https://example.com/recipes/banana-bread"
        onPaste={(e) => {
          const data = e.clipboardData;
          if (!data) return;
          const picked = recipeUrlFromClipboardData(data);
          if (!picked) return;
          e.preventDefault();
          commit(e.currentTarget, picked);
        }}
        onInput={(e) => {
          const el = e.currentTarget;
          const hrefs = [...el.querySelectorAll("a[href]")].map(
            (anchor) => anchor.getAttribute("href") ?? "",
          );
          const plain = el.textContent ?? "";
          const picked = recipeUrlFromClipboard({ plain, hrefs });
          commit(el, picked ?? plain);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          e.currentTarget.closest("form")?.requestSubmit();
        }}
      />
    </Input.Wrapper>
  );
});

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

  const setLink = useCallback((value: string) => {
    setInput(value);
  }, []);

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
          Import recipe
        </Button>
      </Group>

      <Modal
        opened={opened}
        onClose={() => {
          if (!importing) {
            setOpened(false);
            setInput("");
          }
        }}
        title="Import a recipe"
        centered
      >
        <fetcher.Form method="post" action="/recipes/import">
          <input type="hidden" name="_csrf" value={csrfToken} />
          <Stack gap="sm">
            <Text size="sm" c="dimmed">
              Paste a link to a recipe page, or a kptncook share URL (e.g.
              https://share.kptncook.com/…) or recipe id. The KptnCook
              share message can be pasted as-is, including when the URL
              is only attached to the sentence. The fields below will be
              pre-filled; review and edit before saving.
            </Text>
            <input type="hidden" name="input" value={input} />
            <ImportLinkField key={opened ? "open" : "closed"} onValue={setLink} />
            {fetcherError && (
              <Text size="sm" c="red" role="alert">
                {fetcherError}
              </Text>
            )}
            <Group justify="flex-end">
              <Button
                type="button"
                variant="default"
                onClick={() => {
                  setOpened(false);
                  setInput("");
                }}
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
