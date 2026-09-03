import { useState, type ComponentProps } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen, userEvent, waitFor } from "storybook/test";
import type { ProductFeedbackCapability } from "@paperclipai/shared";
import { ProductFeedbackDialog } from "@/components/ProductFeedbackDialog";
import { Button } from "@/components/ui/button";

const capability: ProductFeedbackCapability = {
  enabled: true,
  provider: "posthog",
  posthog: {
    apiHost: "https://us.i.posthog.com",
    projectToken: "phc_storybook_public_token",
    surveyId: "survey-story",
    questionId: "question-story",
  },
  limits: { feedbackMaxLength: 5_000, diagnosticCount: 5 },
};

const localValidationGrant = {
  grantToken: "storybook-single-use-grant",
  submissionMode: "local_validation" as const,
  validationRunId: "storybook-validation",
  opaqueInstallationId: "storybook-installation",
  expiresAt: "2026-09-02T00:00:00.000Z",
};

function FeedbackStory(props: ComponentProps<typeof ProductFeedbackDialog>) {
  const [open, setOpen] = useState(true);
  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      {!open ? <Button onClick={() => setOpen(true)}>Open feedback</Button> : null}
      <ProductFeedbackDialog {...props} open={open} onOpenChange={setOpen} />
    </div>
  );
}

async function enterFeedbackAndSubmit() {
  await userEvent.type(
    screen.getByLabelText("What could Paperclip do better?"),
    "Make this workflow easier to inspect.",
  );
  await userEvent.click(screen.getByRole("button", { name: "Send feedback" }));
}

const meta = {
  title: "Product/Feedback dialog",
  component: ProductFeedbackDialog,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onOpenChange: () => undefined,
    capability,
    deploymentMode: "authenticated",
    knownEmail: "owner@example.com",
    appVersion: "2026.901.0",
    captureEvent: async () => undefined,
    requestGrant: async () => localValidationGrant,
  },
  render: (args) => <FeedbackStory {...args} />,
} satisfies Meta<typeof ProductFeedbackDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const KnownAccountEmail: Story = {};

export const LocalEmailEntry: Story = {
  args: {
    deploymentMode: "local_trusted",
    knownEmail: null,
  },
};

export const ConsentOff: Story = {
  play: async () => {
    await userEvent.click(screen.getByRole("checkbox"));
  },
};

export const ChangedAccountEmail: Story = {
  play: async () => {
    await userEvent.click(screen.getByRole("button", { name: "Change" }));
  },
};

export const Submitting: Story = {
  args: {
    requestGrant: async () => new Promise<never>(() => undefined),
  },
  play: enterFeedbackAndSubmit,
};

export const Retry: Story = {
  args: {
    requestGrant: async () => {
      throw new Error("The local grant broker is unavailable");
    },
  },
  play: async () => {
    await enterFeedbackAndSubmit();
    await waitFor(() => screen.getByRole("button", { name: "Try again" }));
  },
};

export const Success: Story = {
  play: async () => {
    await enterFeedbackAndSubmit();
    await waitFor(() => screen.getByRole("heading", { name: "Feedback sent" }));
  },
};
