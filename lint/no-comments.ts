import { definePlugin, defineRule } from "vite-plus/lint/plugins";

const disableDirective = /^\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?(?=\s|$)/u;

const noComments = defineRule({
  meta: {
    type: "problem",
    messages: {
      forbidden:
        "Comments are not allowed. Put decisions in an ADR and express intent in names, types, or tests.",
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (disableDirective.test(comment.value)) {
            throw new Error(
              `${context.filename}:${comment.loc.start.line}:${comment.loc.start.column + 1} Lint disable comments are not allowed.`,
            );
          }
          context.report({
            loc: comment.loc,
            messageId: "forbidden",
          });
        }
      },
    };
  },
});

export default definePlugin({
  meta: { name: "os" },
  rules: {
    "no-comments": noComments,
  },
});
