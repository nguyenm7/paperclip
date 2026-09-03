import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../posthog/asana-local-validation.hog", import.meta.url),
  "utf8",
);

describe("PostHog Asana local-validation destination", () => {
  it("creates the task in the project before placing it in the validation section", () => {
    expect(source).toContain("'projects': ['1218079435761879']");
    expect(source).not.toContain("'memberships':");
    expect(source).toContain(
      "https://app.asana.com/api/1.0/sections/1218079745693014/addTask",
    );
    expect(source).toContain("'task': response.body.data.gid");
  });
});
