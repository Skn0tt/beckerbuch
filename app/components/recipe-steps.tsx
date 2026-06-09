import { Typography } from "@mantine/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Props = {
  children: string;
};

/**
 * Renders recipe steps written in Markdown.
 *
 * Uses react-markdown so output is a React tree (no dangerouslySetInnerHTML,
 * no separate sanitization step). GFM is enabled so users get task lists,
 * tables, autolinks and strikethrough.
 */
export function RecipeSteps({ children }: Props) {
  return (
    <Typography className="recipe-steps">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer" />
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </Typography>
  );
}
