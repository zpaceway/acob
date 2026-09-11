import { generateBid, isBid } from "./types.js";
import type { Bid } from "./types.js";

export const BID_STORAGE_KEY = "bid" as const;

export async function getOrCreateBid(): Promise<Bid> {
  const stored = await chrome.storage.local.get(
    BID_STORAGE_KEY,
  );
  const candidate = (stored as Record<string, unknown>)[BID_STORAGE_KEY];
  if (isBid(candidate)) {
    return candidate;
  }
  const bid = generateBid();
  await chrome.storage.local.set({ [BID_STORAGE_KEY]: bid });
  return bid;
}

export async function rotateBid(): Promise<Bid> {
  const bid = generateBid();
  await chrome.storage.local.set({ [BID_STORAGE_KEY]: bid });
  return bid;
}
