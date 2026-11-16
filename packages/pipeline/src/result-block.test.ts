import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ImplementOutputSchema } from "./agent.ts";
import { resultBlock } from "./result-block.ts";

// The last messages of Runs 684, 688 and 691: each wrote <result> inside its JSON's strings (a summary, an
// acceptance criterion copied word for word), and Sandcastle cut the block there.
const finalMessage = (run: number) =>
  readFileSync(
    new URL(`./testing/result-block/run-${run}.txt`, import.meta.url),
    "utf8",
  );

describe("the <result> block of an agent's last message", () => {
  it("is what sits between the line that ends with <result> and the line that starts with </result>", () => {
    const text = 'done.\n\n<result>\n{ "status": "done" }\n</result>';
    expect(JSON.parse(resultBlock(text, "result") ?? "")).toEqual({
      status: "done",
    });
  });

  it("ignores <result> written inline, in prose or inside the JSON's strings", () => {
    const text = [
      "every `<result>` example now passes.",
      "",
      "<result>",
      '{ "summary": "each <result> example is checked", "status": "done" }',
      "</result>",
    ].join("\n");
    expect(JSON.parse(resultBlock(text, "result") ?? "")).toEqual({
      summary: "each <result> example is checked",
      status: "done",
    });
  });

  it("allows prose on the tag lines, outside the tags: Cursor joins the agent's messages without a newline", () => {
    const text =
      'All done.<result>\n{ "status": "done" }\n</result>That first run was the red test.';
    expect(JSON.parse(resultBlock(text, "result") ?? "")).toEqual({
      status: "done",
    });
  });

  it("takes the last block when an example block came earlier", () => {
    const text =
      '<result>\n{ "status": "example" }\n</result>\nthen\n<result>\n{ "status": "done" }\n</result>\n';
    expect(JSON.parse(resultBlock(text, "result") ?? "")).toEqual({
      status: "done",
    });
  });

  it("drops a ```json fence around the JSON", () => {
    const text = '<result>\n```json\n{ "status": "done" }\n```\n</result>';
    expect(JSON.parse(resultBlock(text, "result") ?? "")).toEqual({
      status: "done",
    });
  });

  it("is nothing when no line ends with the opening tag", () => {
    expect(resultBlock("the `<result>` tag was never written", "result")).toBe(
      undefined,
    );
  });

  it.each([684, 688, 691])(
    "reads run %i's result, which Sandcastle cut inside a JSON string",
    (run) => {
      const body = resultBlock(finalMessage(run), "result");
      expect(
        ImplementOutputSchema.safeParse(JSON.parse(body ?? "")).success,
      ).toBe(true);
    },
  );
});
