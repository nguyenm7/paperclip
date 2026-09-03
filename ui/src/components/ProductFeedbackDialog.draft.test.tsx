// @vitest-environment jsdom

// Covers restore (close/reopen, remount), success clear, manual clear,
// failed-send retention, scope changes, and storage exceptions at the dialog
// level. Malformed/over-limit stored values are covered in
// ui/src/lib/product-feedback-draft.test.ts.

import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductFeedbackCapability } from "@paperclipai/shared";
import { productFeedbackDraftKey } from "@/lib/product-feedback-draft";
import { ProductFeedbackDialog } from "./ProductFeedbackDialog";

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div>{children}</div> : null,
  DialogContent: ({
    children,
    className,
    onOpenAutoFocus,
  }: {
    children: React.ReactNode;
    className?: string;
    onOpenAutoFocus?: (event: { preventDefault: () => void }) => void;
  }) => {
    React.useEffect(() => {
      onOpenAutoFocus?.({ preventDefault: vi.fn() });
    }, [onOpenAutoFocus]);
    return <div data-testid="dialog-content" className={className}>{children}</div>;
  },
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

const capability: ProductFeedbackCapability = {
  enabled: true,
  provider: "posthog",
  posthog: {
    apiHost: "https://us.i.posthog.com",
    projectToken: "phc_public_test_token",
    surveyId: "survey-123",
    questionId: "question-456",
  },
  limits: { feedbackMaxLength: 5_000, diagnosticCount: 5 },
};

const LOCAL_KEY = productFeedbackDraftKey("local-board", "survey-123")!;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  await callback();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function flush(attempts = 2) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await act(async () => Promise.resolve());
  }
}

async function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(() => {
    const prototype = element instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function findButton(label: string) {
  return Array.from(document.body.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === label,
  );
}

function textarea() {
  return document.body.querySelector("textarea") as HTMLTextAreaElement;
}

function storedBody(key: string): string | null {
  const raw = window.sessionStorage.getItem(key);
  if (raw === null) return null;
  return (JSON.parse(raw) as { body: string }).body;
}

describe("ProductFeedbackDialog draft recovery", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalResizeObserver: typeof ResizeObserver | undefined;

  beforeEach(() => {
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    globalThis.ResizeObserver = originalResizeObserver!;
    document.body.innerHTML = "";
    window.sessionStorage.clear();
    vi.clearAllMocks();
  });

  function baseProps() {
    return {
      onOpenChange: vi.fn(),
      capability,
      deploymentMode: "local_trusted" as const,
      captureEvent: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("keeps the draft across close and reopen and persists it while typing", async () => {
    const props = baseProps();
    await act(() => root.render(<ProductFeedbackDialog {...props} open />));
    await flush();
    await setValue(textarea(), "Unfinished thought");
    expect(storedBody(LOCAL_KEY)).toBe("Unfinished thought");

    await act(() => findButton("Cancel")?.click());
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    await act(() => root.render(<ProductFeedbackDialog {...props} open={false} />));
    await act(() => root.render(<ProductFeedbackDialog {...props} open />));
    await flush();

    expect(textarea().value).toBe("Unfinished thought");
    expect(storedBody(LOCAL_KEY)).toBe("Unfinished thought");
  });

  it("restores the draft after a full unmount and remount (same tab session)", async () => {
    const props = baseProps();
    await act(() => root.render(<ProductFeedbackDialog {...props} open />));
    await flush();
    await setValue(textarea(), "Survives a remount");

    await act(() => root.unmount());
    root = createRoot(container);
    await act(() => root.render(<ProductFeedbackDialog {...baseProps()} open />));
    await flush();

    expect(textarea().value).toBe("Survives a remount");
  });

  it("removes the stored draft when the operator manually clears the body", async () => {
    const props = baseProps();
    await act(() => root.render(<ProductFeedbackDialog {...props} open />));
    await flush();
    await setValue(textarea(), "About to be cleared");
    expect(storedBody(LOCAL_KEY)).toBe("About to be cleared");

    await setValue(textarea(), "");
    expect(window.sessionStorage.getItem(LOCAL_KEY)).toBeNull();
    expect(textarea().value).toBe("");
  });

  it("keeps the draft after a failed send and clears it only after success", async () => {
    const requestGrant = vi.fn()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce({
        grantToken: "single-use-grant",
        submissionMode: "local_validation",
        validationRunId: "validation-run-1",
        opaqueInstallationId: "installation-ref",
        expiresAt: "2026-09-02T00:00:00.000Z",
      });
    const props = baseProps();
    await act(() => root.render(
      <ProductFeedbackDialog {...props} open requestGrant={requestGrant} />,
    ));
    await flush();

    await setValue(textarea(), "Retry-worthy feedback");
    await setValue(
      document.body.querySelector('input[type="email"]') as HTMLInputElement,
      "reporter@example.com",
    );
    await act(() => findButton("Send feedback")?.click());
    await flush(3);

    expect(document.body.textContent).toContain("Your draft is still here. Try again.");
    expect(storedBody(LOCAL_KEY)).toBe("Retry-worthy feedback");

    await act(() => findButton("Try again")?.click());
    await flush(3);

    expect(document.body.textContent).toContain("Feedback sent");
    expect(window.sessionStorage.getItem(LOCAL_KEY)).toBeNull();

    await act(() => findButton("Done")?.click());
    await act(() => root.render(<ProductFeedbackDialog {...props} open />));
    await flush();
    expect(textarea().value).toBe("");
  });

  it("scopes drafts by user and survey and never keys by an email address", async () => {
    window.sessionStorage.setItem(
      productFeedbackDraftKey("user-a", "survey-123")!,
      JSON.stringify({ version: 1, body: "User A's private draft" }),
    );
    window.sessionStorage.setItem(
      productFeedbackDraftKey("user-b", "survey-999")!,
      JSON.stringify({ version: 1, body: "Other survey draft" }),
    );

    const props = { ...baseProps(), deploymentMode: "authenticated" as const };
    await act(() => root.render(
      <ProductFeedbackDialog {...props} open authenticatedUserId="user-b" />,
    ));
    await flush();
    expect(textarea().value).toBe("");

    await act(() => root.render(
      <ProductFeedbackDialog {...props} open authenticatedUserId="user-a" />,
    ));
    await flush();
    expect(textarea().value).toBe("User A's private draft");

    await setValue(textarea(), "typed as user-a");
    await act(() => root.render(
      <ProductFeedbackDialog {...props} open authenticatedUserId="someone@example.com" />,
    ));
    await flush();
    expect(textarea().value).toBe("");
    await setValue(textarea(), "must stay in memory only");
    const keys = Object.keys(window.sessionStorage).filter((key) =>
      key.startsWith("paperclip.product-feedback.draft"),
    );
    expect(keys.join()).not.toContain(encodeURIComponent("someone@example.com"));
    expect(JSON.stringify(Object.entries(window.sessionStorage))).not.toContain("must stay in memory only");
  });

  it("persists only the body, never email, consent, or diagnostics", async () => {
    const props = baseProps();
    await act(() => root.render(<ProductFeedbackDialog {...props} open />));
    await flush();
    await setValue(textarea(), "Body only");
    await setValue(
      document.body.querySelector('input[type="email"]') as HTMLInputElement,
      "reporter@example.com",
    );

    expect(JSON.parse(window.sessionStorage.getItem(LOCAL_KEY)!)).toEqual({
      version: 1,
      body: "Body only",
    });
    expect(JSON.stringify(Object.entries(window.sessionStorage))).not.toContain("reporter@example.com");
  });

  it("falls back to in-memory behavior when storage writes fail", async () => {
    // jsdom wraps sessionStorage in a named-property proxy, so spying on
    // Storage.prototype does not intercept calls; replace the window property.
    const original = Object.getOwnPropertyDescriptor(window, "sessionStorage")!;
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new DOMException("quota", "QuotaExceededError");
        },
        removeItem: () => {},
        clear: () => {},
        key: () => null,
        length: 0,
      } as unknown as Storage,
    });
    try {
      const props = baseProps();
      await act(() => root.render(<ProductFeedbackDialog {...props} open />));
      await flush();

      await setValue(textarea(), "Still typing fine");
      expect(textarea().value).toBe("Still typing fine");

      await act(() => findButton("Cancel")?.click());
      await act(() => root.render(<ProductFeedbackDialog {...props} open />));
      await flush();
      expect(textarea().value).toBe("Still typing fine");
    } finally {
      Object.defineProperty(window, "sessionStorage", original);
    }
    expect(window.sessionStorage.getItem(LOCAL_KEY)).toBeNull();
  });
});
