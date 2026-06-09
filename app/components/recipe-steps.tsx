import { Typography } from "@mantine/core";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Props = {
  children: string;
  storageId?: string;
};

const STORAGE_PREFIX = "recipe-steps-progress:";

type StoredProgress = {
  expiresAt: number;
  checks: Record<number, boolean>;
};

function nextExpiryAt(now = new Date()): number {
  const expiresAt = new Date(now);
  expiresAt.setHours(2, 0, 0, 0);
  if (expiresAt.getTime() <= now.getTime()) {
    expiresAt.setDate(expiresAt.getDate() + 1);
  }
  return expiresAt.getTime();
}

function hashText(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

function loadProgress(storageKey: string): Record<number, boolean> | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredProgress;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.expiresAt !== "number" ||
      typeof parsed.checks !== "object" ||
      parsed.checks === null
    ) {
      localStorage.removeItem(storageKey);
      return null;
    }
    if (parsed.expiresAt <= Date.now()) {
      localStorage.removeItem(storageKey);
      return null;
    }
    return parsed.checks;
  } catch {
    return null;
  }
}

function saveProgress(storageKey: string, checks: Record<number, boolean>): void {
  if (typeof localStorage === "undefined") return;
  const payload: StoredProgress = {
    expiresAt: nextExpiryAt(),
    checks,
  };
  localStorage.setItem(storageKey, JSON.stringify(payload));
}

function clearProgress(storageKey: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(storageKey);
}

/**
 * Renders recipe steps written in Markdown.
 *
 * Uses react-markdown so output is a React tree (no dangerouslySetInnerHTML,
 * no separate sanitization step). GFM is enabled so users get task lists,
 * tables, autolinks and strikethrough.
 */
export function RecipeSteps({ children, storageId }: Props) {
  const storageKey = useMemo(
    () =>
      storageId ? `${STORAGE_PREFIX}${storageId}:${hashText(children)}` : null,
    [children, storageId],
  );
  const [state, setState] = useState(() => ({
    storageKey,
    progress: storageKey ? loadProgress(storageKey) : null,
  }));
  if (state.storageKey !== storageKey) {
    setState({
      storageKey,
      progress: storageKey ? loadProgress(storageKey) : null,
    });
  }
  const progress = state.progress;

  useEffect(() => {
    if (!storageKey || progress === null) return;
    saveProgress(storageKey, progress);
    const timeout = window.setTimeout(() => {
      clearProgress(storageKey);
      setState((current) => ({
        storageKey: current.storageKey,
        progress: null,
      }));
    }, Math.max(nextExpiryAt() - Date.now(), 0));
    return () => window.clearTimeout(timeout);
  }, [progress, storageKey]);

  let checkboxIndex = 0;

  return (
    <Typography className="recipe-steps">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer" />
          ),
          input: ({ node: _node, type, checked, disabled: _disabled, ...props }) => {
            if (type !== "checkbox") {
              return <input {...props} type={type} />;
            }
            const index = checkboxIndex++;
            return (
              <input
                {...props}
                type="checkbox"
                checked={progress?.[index] ?? Boolean(checked)}
                onChange={(event) => {
                  const nextChecked = event.currentTarget.checked;
                  setState((current) => ({
                    storageKey: current.storageKey,
                    progress: {
                      ...(current.progress ?? {}),
                      [index]: nextChecked,
                    },
                  }));
                }}
              />
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </Typography>
  );
}
