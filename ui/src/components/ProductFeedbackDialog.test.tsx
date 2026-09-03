// @vitest-environment jsdom

import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductFeedbackCapability } from "@paperclipai/shared";
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

describe("ProductFeedbackDialog", () => {
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
    vi.clearAllMocks();
  });

  it("defaults follow-up on and confirms a known authenticated email", async () => {
    const captureEvent = vi.fn().mockResolvedValue(undefined);
    await act(() => root.render(
      <ProductFeedbackDialog
        open
        onOpenChange={vi.fn()}
        capability={capability}
        companyId="11111111-1111-4111-8111-111111111111"
        deploymentMode="authenticated"
        knownEmail="owner@example.com"
        captureEvent={captureEvent}
      />,
    ));
    await flush();

    expect(document.body.textContent).toContain("Share feedback");
    expect(document.body.textContent).toContain("We’ll use owner@example.com");
    const consent = document.body.querySelector('[role="checkbox"]');
    expect(consent?.getAttribute("aria-checked")).toBe("true");
    expect(document.body.querySelector('input[type="email"]')).toBeNull();
    expect(captureEvent).not.toHaveBeenCalled();
  });

  it("moves focus to the feedback field when the dialog opens", async () => {
    await act(() => root.render(
      <ProductFeedbackDialog
        open
        onOpenChange={vi.fn()}
        capability={capability}
        companyId="11111111-1111-4111-8111-111111111111"
        deploymentMode="local_trusted"
        captureEvent={vi.fn().mockResolvedValue(undefined)}
      />,
    ));
    await flush();

    expect(document.activeElement).toBe(document.body.querySelector("textarea"));
    expect(document.body.querySelector('[data-testid="dialog-content"]')?.className)
      .toContain("max-h-(--sz-calc-18)");
  });

  it("seeds the editor from an account email that arrives after mount", async () => {
    const props = {
      open: true,
      onOpenChange: vi.fn(),
      capability,
      companyId: "11111111-1111-4111-8111-111111111111",
      deploymentMode: "authenticated" as const,
      captureEvent: vi.fn().mockResolvedValue(undefined),
    };
    await act(() => root.render(<ProductFeedbackDialog {...props} knownEmail={null} />));
    await flush();
    await act(() => root.render(<ProductFeedbackDialog {...props} knownEmail="owner@example.com" />));
    await flush();
    await act(() => findButton("Change")?.click());

    expect((document.body.querySelector('input[type="email"]') as HTMLInputElement).value)
      .toBe("owner@example.com");
  });

  it("keeps the draft and offers retry when the server grant fails closed", async () => {
    const requestGrant = vi.fn().mockRejectedValue(new Error("unavailable"));
    const captureEvent = vi.fn().mockResolvedValue(undefined);
    await act(() => root.render(
      <ProductFeedbackDialog
        open
        onOpenChange={vi.fn()}
        capability={capability}
        companyId="11111111-1111-4111-8111-111111111111"
        deploymentMode="local_trusted"
        requestGrant={requestGrant}
        captureEvent={captureEvent}
      />,
    ));
    await flush();

    const textarea = document.body.querySelector("textarea") as HTMLTextAreaElement;
    const email = document.body.querySelector('input[type="email"]') as HTMLInputElement;
    await setValue(textarea, "Please keep this draft");
    await setValue(email, "reporter@example.com");
    await act(() => findButton("Send feedback")?.click());
    await flush(3);

    expect(requestGrant).toHaveBeenCalledWith(expect.objectContaining({
      followUpConsent: true,
      reporterEmail: "reporter@example.com",
    }));
    expect(document.body.textContent).toContain("Your draft is still here. Try again.");
    expect((document.body.querySelector("textarea") as HTMLTextAreaElement).value).toBe("Please keep this draft");
    expect(findButton("Try again")).toBeDefined();
    expect(captureEvent).not.toHaveBeenCalledWith("survey sent", expect.anything());
  });

  it("sends contact only to the grant boundary and reports success after survey capture", async () => {
    const requestGrant = vi.fn().mockResolvedValue({
      grantToken: "single-use-grant",
      submissionMode: "local_validation",
      validationRunId: "validation-run-1",
      opaqueInstallationId: "installation-ref",
      expiresAt: "2026-09-02T00:00:00.000Z",
    });
    const captureEvent = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    await act(() => root.render(
      <ProductFeedbackDialog
        open
        onOpenChange={onOpenChange}
        capability={capability}
        companyId="11111111-1111-4111-8111-111111111111"
        deploymentMode="local_trusted"
        requestGrant={requestGrant}
        captureEvent={captureEvent}
      />,
    ));
    await flush();

    await setValue(document.body.querySelector("textarea") as HTMLTextAreaElement, "A private product note");
    await setValue(document.body.querySelector('input[type="email"]') as HTMLInputElement, "reporter@example.com");
    await act(() => findButton("Send feedback")?.click());
    await flush(3);

    const sentCall = captureEvent.mock.calls.find(([event]) => event === "survey sent");
    expect(requestGrant).toHaveBeenCalledOnce();
    expect(requestGrant).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "11111111-1111-4111-8111-111111111111",
    }));
    expect(sentCall).toBeDefined();
    expect(document.body.textContent).toContain("Feedback sent");
    expect(sentCall?.[1]).toMatchObject({
      feedback: "A private product note",
      grant: { grantToken: "single-use-grant" },
    });
    expect(JSON.stringify(sentCall?.[1])).not.toContain("reporter@example.com");

    await act(() => findButton("Done")?.click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(document.body.textContent).toContain("Share feedback");
    expect((document.body.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
  });
});
