import {
  API,
  productFeedbackGrantSchema,
  type ProductFeedbackGrant,
  type ProductFeedbackGrantRequest,
} from "@paperclipai/shared";

export class ProductFeedbackApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ProductFeedbackApiError";
  }
}

export const productFeedbackApi = {
  requestGrant: async (input: ProductFeedbackGrantRequest): Promise<ProductFeedbackGrant> => {
    const response = await fetch(API.productFeedbackGrant, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    });
    const payload = await response.json().catch(() => null) as {
      code?: string;
      error?: string;
    } | null;
    if (!response.ok) {
      throw new ProductFeedbackApiError(
        payload?.error ?? "Feedback delivery could not start. Your draft is still here.",
        payload?.code ?? "product_feedback_grant_failed",
        response.status,
      );
    }
    return productFeedbackGrantSchema.parse(payload);
  },
};
