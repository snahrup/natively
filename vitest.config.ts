import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only the electron main-process unit tests. The vestigial renderer/ CRA
    // folder ships a jest boilerplate test that must not be picked up.
    include: ["electron/**/*.test.ts"],
    environment: "node",
  },
});
