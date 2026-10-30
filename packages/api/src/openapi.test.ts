import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openApiDocument } from "./openapi.ts";

describe("the committed OpenAPI document", () => {
  it("matches the routes; run `pnpm gen:api` after changing one", () => {
    const committed = JSON.parse(
      readFileSync(
        new URL("../../shared/src/api/openapi.json", import.meta.url),
        "utf8",
      ),
    );
    expect(committed).toEqual(JSON.parse(JSON.stringify(openApiDocument())));
  });
});
