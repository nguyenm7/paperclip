// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  productFeedbackDraftKey,
  readProductFeedbackDraft,
  removeProductFeedbackDraft,
  writeProductFeedbackDraft,
} from "./product-feedback-draft";

const MAX_LENGTH = 100;
const KEY = productFeedbackDraftKey("user-1", "survey-123")!;

// jsdom wraps sessionStorage in a named-property proxy, so spying on
// Storage.prototype does not intercept calls. Replace the whole window
// property to simulate storage failures for real.
function installFakeSessionStorage(overrides: Partial<Storage>): () => void {
  const original = Object.getOwnPropertyDescriptor(window, "sessionStorage")!;
  const backing = new Map<string, string>();
  const fake = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
    removeItem: (key: string) => void backing.delete(key),
    clear: () => backing.clear(),
    key: () => null,
    get length() {
      return backing.size;
    },
    ...overrides,
  } as Storage;
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: fake });
  return () => Object.defineProperty(window, "sessionStorage", original);
}

describe("product-feedback-draft storage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });

  it("builds a versioned key scoped by user and survey without delimiter collisions", () => {
    expect(KEY).toBe("paperclip.product-feedback.draft.v1:user-1:survey-123");
    // ":" inside a component is percent-encoded, so distinct (scope, survey)
    // pairs can never produce the same key.
    expect(productFeedbackDraftKey("user:one", "two"))
      .not.toBe(productFeedbackDraftKey("user", "one:two"));
  });

  it("refuses empty and email-like identity scopes", () => {
    expect(productFeedbackDraftKey("", "survey-123")).toBeNull();
    expect(productFeedbackDraftKey("reporter@example.com", "survey-123")).toBeNull();
    expect(productFeedbackDraftKey("user-1", "")).toBeNull();
  });

  it("round-trips a body and stores only version and body", () => {
    writeProductFeedbackDraft(KEY, "Keep this draft", MAX_LENGTH);
    expect(readProductFeedbackDraft(KEY, MAX_LENGTH)).toBe("Keep this draft");
    expect(JSON.parse(window.sessionStorage.getItem(KEY)!)).toEqual({
      version: 1,
      body: "Keep this draft",
    });
  });

  it("removes the key when writing an empty body", () => {
    writeProductFeedbackDraft(KEY, "something", MAX_LENGTH);
    writeProductFeedbackDraft(KEY, "", MAX_LENGTH);
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it("does not store an over-limit body and keeps the previous valid draft", () => {
    writeProductFeedbackDraft(KEY, "short", MAX_LENGTH);
    writeProductFeedbackDraft(KEY, "x".repeat(MAX_LENGTH + 1), MAX_LENGTH);
    expect(readProductFeedbackDraft(KEY, MAX_LENGTH)).toBe("short");
  });

  it.each([
    ["not JSON", "{{{"],
    ["wrong shape", JSON.stringify({ hello: "world" })],
    ["wrong version", JSON.stringify({ version: 2, body: "x" })],
    ["non-string body", JSON.stringify({ version: 1, body: 42 })],
    ["extra persisted field", JSON.stringify({ version: 1, body: "x", email: "reporter@example.com" })],
    ["empty body", JSON.stringify({ version: 1, body: "" })],
    ["over-limit body", JSON.stringify({ version: 1, body: "x".repeat(MAX_LENGTH + 1) })],
  ])("ignores and removes a stored value that is %s", (_label, raw) => {
    window.sessionStorage.setItem(KEY, raw);
    expect(readProductFeedbackDraft(KEY, MAX_LENGTH)).toBeNull();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it("returns null without throwing when getItem throws", () => {
    const restore = installFakeSessionStorage({
      getItem: () => {
        throw new Error("denied");
      },
    });
    try {
      expect(readProductFeedbackDraft(KEY, MAX_LENGTH)).toBeNull();
    } finally {
      restore();
    }
  });

  it("swallows quota errors on write and removal errors on remove", () => {
    const restore = installFakeSessionStorage({
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    });
    try {
      expect(() => writeProductFeedbackDraft(KEY, "body", MAX_LENGTH)).not.toThrow();
      expect(() => removeProductFeedbackDraft(KEY)).not.toThrow();
      expect(window.sessionStorage.getItem(KEY)).toBeNull();
    } finally {
      restore();
    }
  });

  it("treats a completely unavailable sessionStorage as a silent no-op", () => {
    const original = Object.getOwnPropertyDescriptor(window, "sessionStorage")!;
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    try {
      expect(() => writeProductFeedbackDraft(KEY, "body", MAX_LENGTH)).not.toThrow();
      expect(readProductFeedbackDraft(KEY, MAX_LENGTH)).toBeNull();
      expect(() => removeProductFeedbackDraft(KEY)).not.toThrow();
    } finally {
      Object.defineProperty(window, "sessionStorage", original);
    }
  });
});
