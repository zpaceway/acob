import assert from "node:assert/strict";
import test from "node:test";

import { BID_STORAGE_KEY, getOrCreateBid, rotateBid } from "../src/bid.js";
import {
  instructionResultUrl,
  nextInstructionsUrl,
} from "../src/lifecycle.js";
import { ACOBSettings } from "../src/settings.js";
import { generateBid, isBid } from "../src/types.js";
import type { ClaimedInstruction } from "../src/types.js";
import {
  isClaimedInstruction,
  isSupportedInstruction,
} from "../src/validation.js";

function instruction(
  action: string,
  payload: unknown,
  bid?: unknown,
): ClaimedInstruction {
  const value: Record<string, unknown> = { id: 1, action, payload };
  if (bid !== undefined) {
    value.bid = bid;
  }
  return value as unknown as ClaimedInstruction;
}

test("isBid accepts 32-char lowercase hex only", () => {
  assert.equal(isBid("0123456789abcdef0123456789abcdef"), true);
  assert.equal(isBid("ffffffffffffffffffffffffffffffff"), true);
  assert.equal(isBid(null), false);
  assert.equal(isBid(undefined), false);
  assert.equal(isBid(""), false);
  assert.equal(isBid("0123456789ABCDEF0123456789ABCDEF"), false);
  assert.equal(isBid("0123456789abcdef0123456789abcde"), false);
  assert.equal(isBid("0123456789abcdef0123456789abcdef0"), false);
  assert.equal(isBid("0123456789abcdef-0123456789abcde"), false);
  assert.equal(isBid("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"), false);
  assert.equal(isBid(123), false);
  assert.equal(isBid({}), false);
});

test("generateBid returns uuid4 hex without dashes", () => {
  const first = generateBid();
  const second = generateBid();
  assert.equal(typeof first, "string");
  assert.equal(first.length, 32);
  assert.equal(isBid(first), true);
  assert.equal(isBid(second), true);
  assert.match(first, /^[0-9a-f]{32}$/);
  assert.notEqual(first, second);
});

test("InstructionRequest types allow optional bid passthrough", () => {
  const bid = generateBid();
  const list = { action: "list", bid } as const;
  const click = { action: "click", tid: 1, selector: "button", bid } as const;
  const batch = {
    action: "batch",
    actions: [list, click],
    bid,
  } as const;
  assert.equal(isBid(list.bid), true);
  assert.equal(isBid(click.bid), true);
  assert.equal(isBid(batch.bid), true);
});

test("isClaimedInstruction accepts missing, null, and valid bid", () => {
  const bid = generateBid();
  assert.equal(
    isClaimedInstruction(instruction("list", {})),
    true,
  );
  assert.equal(
    isClaimedInstruction(instruction("list", {}, null)),
    true,
  );
  assert.equal(isClaimedInstruction(instruction("list", {}, bid)), true);
});

test("isClaimedInstruction rejects invalid bid", () => {
  assert.equal(
    isClaimedInstruction(instruction("list", {}, "not-a-bid")),
    false,
  );
  assert.equal(
    isClaimedInstruction(instruction("list", {}, "ABCDEF0123456789ABCDEF0123456789")),
    false,
  );
  assert.equal(isClaimedInstruction(instruction("list", {}, 123)), false);
});

test("isSupportedInstruction accepts optional valid bid", () => {
  const bid = generateBid();
  assert.equal(
    isSupportedInstruction(instruction("list", {}, bid)),
    true,
  );
  assert.equal(
    isSupportedInstruction(instruction("list", {}, null)),
    true,
  );
  assert.equal(isSupportedInstruction(instruction("list", {})), true);
  assert.equal(
    isSupportedInstruction(
      instruction("click", { tid: 1, selector: "button" }, bid),
    ),
    true,
  );
});

test("isSupportedInstruction rejects invalid bid", () => {
  assert.equal(
    isSupportedInstruction(instruction("list", {}, "bad")),
    false,
  );
  assert.equal(
    isSupportedInstruction(
      instruction("click", { tid: 1, selector: "button" }, "BADBID"),
    ),
    false,
  );
});

test("isSupportedInstruction validates batch sub-action bids", () => {
  const bid = generateBid();
  const valid = instruction("batch", {
    actions: [
      { action: "list", bid },
      { action: "click", tid: 1, selector: "button" },
    ],
  });
  assert.equal(isSupportedInstruction(valid), true);

  const invalid = instruction("batch", {
    actions: [{ action: "list", bid: "nope" }],
  });
  assert.equal(isSupportedInstruction(invalid), false);
});

test("nextInstructionsUrl and instructionResultUrl include bid", () => {
  const configuration = ACOBSettings.normalizeConfiguration({
    baseUrl: "http://127.0.0.1:58346",
  });
  const bid = "0123456789abcdef0123456789abcdef";
  assert.equal(
    nextInstructionsUrl(configuration, bid as never, 4),
    "http://127.0.0.1:58346/api/instructions/next/?bid=0123456789abcdef0123456789abcdef&limit=4",
  );
  assert.equal(
    instructionResultUrl(configuration, 12),
    "http://127.0.0.1:58346/api/instructions/12/result/",
  );
});

type StoredValues = Record<string, unknown>;

function installBidStorageMock(stored: StoredValues): void {
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          get: async (key?: string | string[]) => {
            if (typeof key === "string") {
              return key in stored ? { [key]: stored[key] } : {};
            }
            return { ...stored };
          },
          set: async (values: StoredValues) => {
            Object.assign(stored, values);
          },
        },
      },
    },
  });
}

test("getOrCreateBid persists and reuses the stored bid", async () => {
  const stored: StoredValues = {};
  installBidStorageMock(stored);
  try {
    const first = await getOrCreateBid();
    assert.equal(isBid(first), true);
    assert.equal(stored[BID_STORAGE_KEY], first);
    const second = await getOrCreateBid();
    assert.equal(second, first);
  } finally {
    Reflect.deleteProperty(globalThis, "chrome");
  }
});

test("getOrCreateBid regenerates when the stored bid is invalid", async () => {
  const stored: StoredValues = { [BID_STORAGE_KEY]: "invalid" };
  installBidStorageMock(stored);
  try {
    const bid = await getOrCreateBid();
    assert.equal(isBid(bid), true);
    assert.equal(stored[BID_STORAGE_KEY], bid);
  } finally {
    Reflect.deleteProperty(globalThis, "chrome");
  }
});

test("rotateBid generates a new persisted bid", async () => {
  const stored: StoredValues = {};
  installBidStorageMock(stored);
  try {
    const first = await getOrCreateBid();
    const rotated = await rotateBid();
    assert.equal(isBid(rotated), true);
    assert.notEqual(rotated, first);
    assert.equal(stored[BID_STORAGE_KEY], rotated);
    const again = await getOrCreateBid();
    assert.equal(again, rotated);
  } finally {
    Reflect.deleteProperty(globalThis, "chrome");
  }
});
