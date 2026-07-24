import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export function createWebhookSignature(secret, timestamp, rawBody) {
  return createHmac("sha256", secret)
    .update(String(timestamp))
    .update(".")
    .update(rawBody)
    .digest("hex");
}

export function verifyWebhookSignature({
  secret,
  timestamp,
  signature,
  rawBody,
  now = Date.now(),
  toleranceSeconds = WEBHOOK_TOLERANCE_SECONDS,
}) {
  if (
    !secret ||
    typeof timestamp !== "string" ||
    !/^\d+$/.test(timestamp) ||
    typeof signature !== "string" ||
    !/^[0-9a-f]{64}$/i.test(signature) ||
    !Buffer.isBuffer(rawBody)
  ) {
    return false;
  }

  const timestampSeconds = Number(timestamp);
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(Math.floor(now / 1000) - timestampSeconds) > toleranceSeconds
  ) {
    return false;
  }

  const expected = Buffer.from(
    createWebhookSignature(secret, timestamp, rawBody),
    "hex",
  );
  const received = Buffer.from(signature, "hex");

  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}
