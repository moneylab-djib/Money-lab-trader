// PROOF FOR THE OWNER, REMOVED IN THE NEXT COMMIT: a deliberately broken test must turn GitHub CI red.
import { expect, it } from "vitest";

it("deliberately broken test (CI must fail on it)", () => {
  expect(1 + 1).toBe(3);
});
