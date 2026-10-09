// PROOF FOR THE OWNER, REMOVED IN THE NEXT COMMIT: a test that never ends must fail GitHub CI at the
// check's time limit (600 s), where the old CI turned the time limit into a success.
import { it } from "vitest";

it("deliberately never ends (a synchronous loop vitest cannot interrupt)", () => {
  for (;;) {
    // never ends
  }
});
