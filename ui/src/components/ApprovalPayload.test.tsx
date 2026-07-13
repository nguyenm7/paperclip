// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../context/ThemeContext";
import { ApprovalPayloadRenderer, approvalLabel } from "./ApprovalPayload";

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    ...props
  }: { children: React.ReactNode; to: string } & React.ComponentProps<"a">) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    get: vi.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("approvalLabel", () => {
  it("uses payload titles for generic board approvals", () => {
    expect(
      approvalLabel("request_board_approval", {
        title: "Reply with an ASCII frog",
      }),
    ).toBe("Board Approval: Reply with an ASCII frog");
  });
});

describe("ApprovalPayloadRenderer", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function renderPayload(props: React.ComponentProps<typeof ApprovalPayloadRenderer>) {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <ApprovalPayloadRenderer {...props} />
          </ThemeProvider>
        </QueryClientProvider>,
      );
    });

    return root;
  }

  it("renders request_board_approval payload fields without falling back to raw JSON", () => {
    const root = renderPayload({
      type: "request_board_approval",
      payload: {
        title: "Reply with an ASCII frog",
        summary: "Board asked for approval before posting the frog.",
        recommendedAction: "Approve the frog reply.",
        nextActionOnApproval: "Post the frog comment on the issue.",
        risks: ["The frog might be too powerful."],
        proposedComment: "(o)<",
      },
    });

    expect(container.textContent).toContain("Reply with an ASCII frog");
    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).toContain("Approve the frog reply.");
    expect(container.textContent).toContain("Post the frog comment on the issue.");
    expect(container.textContent).toContain("The frog might be too powerful.");
    expect(container.textContent).toContain("(o)<");
    expect(container.textContent).not.toContain("\"recommendedAction\"");

    act(() => {
      root.unmount();
    });
  });

  it("can hide the repeated title when the card header already shows it", () => {
    const root = renderPayload({
      type: "request_board_approval",
      hidePrimaryTitle: true,
      payload: {
        title: "Reply with an ASCII frog",
        summary: "Board asked for approval before posting the frog.",
      },
    });

    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).not.toContain("TitleReply with an ASCII frog");

    act(() => {
      root.unmount();
    });
  });

  it("renders markdown in summary and recommendedAction, including inline images", () => {
    const root = renderPayload({
      type: "request_board_approval",
      payload: {
        summary: "Contact sheet below.\n\n![Cycle 04 contact sheet](/api/attachments/att-123/content)",
        recommendedAction: "Approve **variant B**.",
      },
    });

    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("/api/attachments/att-123/content");
    expect(image?.getAttribute("alt")).toBe("Cycle 04 contact sheet");
    expect(container.textContent).not.toContain("![Cycle 04 contact sheet]");
    const bold = Array.from(container.querySelectorAll("strong")).map((el) => el.textContent);
    expect(bold).toContain("variant B");

    act(() => {
      root.unmount();
    });
  });

  it("renders a payload.images thumbnail strip and ignores malformed entries", () => {
    const root = renderPayload({
      type: "request_board_approval",
      payload: {
        summary: "Pick a variant.",
        images: [
          { attachmentId: "att-1", caption: "Variant A" },
          { attachmentId: "att-2" },
          { attachmentId: "   " },
          { caption: "no attachment id" },
          "not-an-object",
          null,
        ],
      },
    });

    const images = Array.from(container.querySelectorAll("img"));
    expect(images.map((el) => el.getAttribute("src"))).toEqual([
      "/api/attachments/att-1/content",
      "/api/attachments/att-2/content",
    ]);
    expect(container.textContent).toContain("Variant A");
    expect(container.textContent).toContain("Assets");
    expect(container.textContent).not.toContain("no attachment id");

    act(() => {
      root.unmount();
    });
  });
});
