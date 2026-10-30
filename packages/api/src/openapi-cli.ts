import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openApiDocument } from "./openapi.ts";

export const OPENAPI_JSON = fileURLToPath(
  new URL("../../shared/src/api/openapi.json", import.meta.url),
);

writeFileSync(OPENAPI_JSON, `${JSON.stringify(openApiDocument(), null, 2)}\n`);
console.log(`wrote ${OPENAPI_JSON}`);
