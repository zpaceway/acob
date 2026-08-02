import assert from "node:assert/strict";
import test from "node:test";

import {
  OperationTimeoutError,
  withTerminationOnTimeout,
} from "../src/timeouts.js";

test("terminates an operation that exceeds its timeout", async () => {
  let terminated = false;
  const operation = new Promise<never>(() => undefined);

  await assert.rejects(
    withTerminationOnTimeout(operation, 5, "execution timed out", async () => {
      terminated = true;
    }),
    (error: unknown) =>
      error instanceof OperationTimeoutError &&
      error.message === "execution timed out",
  );

  assert.equal(terminated, true);
});

test("allows cleanup to outlive a short operation timeout", async () => {
  await assert.rejects(
    withTerminationOnTimeout(
      new Promise<never>(() => undefined),
      1,
      "execution timed out",
      () => new Promise((resolve) => setTimeout(resolve, 10)),
    ),
    (error: unknown) =>
      error instanceof OperationTimeoutError &&
      error.message === "execution timed out",
  );
});

test("does not terminate an operation that finishes", async () => {
  let terminated = false;

  const result = await withTerminationOnTimeout(
    Promise.resolve(42),
    50,
    "execution timed out",
    async () => {
      terminated = true;
    },
  );

  assert.equal(result, 42);
  assert.equal(terminated, false);
});

test("preserves ordinary operation failures", async () => {
  let terminated = false;

  await assert.rejects(
    withTerminationOnTimeout(
      Promise.reject(new Error("evaluation failed")),
      50,
      "execution timed out",
      async () => {
        terminated = true;
      },
    ),
    /evaluation failed/,
  );

  assert.equal(terminated, false);
});
