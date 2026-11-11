import { describe, expect, it } from "vitest";
import {
  specTemplateWarnings,
  testingDecisionsNamesSeams,
} from "./spec-template.ts";

describe("testingDecisionsNamesSeams", () => {
  it.each([
    ["Seam: HTTP", true],
    ["测试缝", true],
    ["good tests only", false],
  ])("%s → %s", (body, ok) => {
    expect(testingDecisionsNamesSeams(body)).toBe(ok);
  });
});

describe("specTemplateWarnings", () => {
  it("does not warn about seams when Testing Decisions names seam in English", () => {
    const body = `## Problem Statement

p

## User Stories

n/a

## Scope

s

## Decisions

d

## Testing Decisions

Seams: HTTP create order, list orders.

## Out of Scope

x
`;
    const warnings = specTemplateWarnings(body);
    expect(warnings.some((w) => w.includes("does not name the seams"))).toBe(
      false,
    );
  });

  it("does not warn when Testing Decisions names seams with 缝", () => {
    const body = `## Problem Statement

p

## User Stories

n/a

## Scope

s

## Decisions

d

## Testing Decisions

在 HTTP 边界写测试，测试缝在创建订单 API。

## Out of Scope

x
`;
    const warnings = specTemplateWarnings(body);
    expect(warnings.some((w) => w.includes("does not name the seams"))).toBe(
      false,
    );
  });

  it("warns when Testing Decisions names neither seam nor 缝", () => {
    const body = `## Problem Statement

p

## User Stories

n/a

## Scope

s

## Decisions

d

## Testing Decisions

只写模块名，不出现测试边界用词。

## Out of Scope

x
`;
    expect(
      specTemplateWarnings(body).some((w) =>
        w.includes("does not name the seams"),
      ),
    ).toBe(true);
  });
});
