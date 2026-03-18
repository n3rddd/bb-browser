import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRuntimeEvaluateParams,
  getRuntimeEvaluateError,
} from "../dist/index.js";

test("buildRuntimeEvaluateParams enables repl mode and async defaults", () => {
  assert.deepEqual(
    buildRuntimeEvaluateParams("await Promise.resolve(1)"),
    {
      expression: "await Promise.resolve(1)",
      returnByValue: true,
      awaitPromise: true,
      replMode: true,
    },
  );
});

test("buildRuntimeEvaluateParams respects explicit overrides", () => {
  assert.deepEqual(
    buildRuntimeEvaluateParams("2 + 2", {
      returnByValue: false,
      awaitPromise: false,
    }),
    {
      expression: "2 + 2",
      returnByValue: false,
      awaitPromise: false,
      replMode: true,
    },
  );
});

test("getRuntimeEvaluateError prefers the detailed exception description", () => {
  assert.equal(
    getRuntimeEvaluateError({
      exceptionDetails: {
        text: "Uncaught",
        exception: {
          description: "ReferenceError: missingValue is not defined",
        },
      },
    }),
    "ReferenceError: missingValue is not defined",
  );
});

test("getRuntimeEvaluateError falls back to the protocol text", () => {
  assert.equal(
    getRuntimeEvaluateError({
      exceptionDetails: {
        text: "Uncaught",
      },
    }),
    "Uncaught",
  );
});
