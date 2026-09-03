import { useCallback, useEffect, useRef, useState } from "react";

// Same-session draft recovery for the product-feedback dialog.
// Persists ONLY the feedback message body to sessionStorage, scoped by a
// versioned key derived from a non-contact user scope and the survey ID.
// Storage is strictly optional: every read, write, and removal falls back to
// in-memory behavior when the browser denies or breaks storage access.

const DRAFT_KEY_PREFIX = "paperclip.product-feedback.draft.v1";

interface StoredDraft {
  version: 1;
  body: string;
}

// ":" is always percent-encoded by encodeURIComponent, so encoded scope and
// survey components can never collide with the delimiter.
export function productFeedbackDraftKey(scope: string, surveyId: string): string | null {
  const normalizedScope = scope.trim();
  const normalizedSurveyId = surveyId.trim();
  if (!normalizedScope || normalizedScope.includes("@") || !normalizedSurveyId) return null;
  return `${DRAFT_KEY_PREFIX}:${encodeURIComponent(normalizedScope)}:${encodeURIComponent(normalizedSurveyId)}`;
}

function isStoredDraft(value: unknown): value is StoredDraft {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2
    && keys.includes("version")
    && keys.includes("body")
    && (value as StoredDraft).version === 1
    && typeof (value as StoredDraft).body === "string";
}

function safeSessionStorage(): Storage | null {
  try {
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function readProductFeedbackDraft(key: string, maxLength: number): string | null {
  const storage = safeSessionStorage();
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;

  let body: string | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isStoredDraft(parsed)) body = parsed.body;
  } catch {
    body = null;
  }

  if (body === null || body.length === 0 || body.length > maxLength) {
    removeProductFeedbackDraft(key);
    return null;
  }
  return body;
}

export function writeProductFeedbackDraft(key: string, body: string, maxLength: number): void {
  if (body.length === 0) {
    removeProductFeedbackDraft(key);
    return;
  }
  if (body.length > maxLength) return;
  const storage = safeSessionStorage();
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify({ version: 1, body } satisfies StoredDraft));
  } catch {
    // Quota or availability failure: the in-memory draft remains authoritative.
  }
}

export function removeProductFeedbackDraft(key: string): void {
  const storage = safeSessionStorage();
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Storage is optional; a failed removal must not block the dialog.
  }
}

export function useProductFeedbackDraft(
  key: string | null,
  maxLength: number,
): {
  feedback: string;
  setFeedback: (next: string) => void;
  clearStoredDraft: () => void;
} {
  const [feedback, setFeedbackState] = useState(() =>
    key ? (readProductFeedbackDraft(key, maxLength) ?? "") : "",
  );
  const hydratedKeyRef = useRef(key);

  // Hydrate whenever the scope/survey key changes. Hydration only reads;
  // persistence happens exclusively through user edits below, so an initial
  // blank render can never overwrite a saved draft.
  useEffect(() => {
    if (hydratedKeyRef.current === key) return;
    const previousKey = hydratedKeyRef.current;
    hydratedKeyRef.current = key;
    const stored = key ? readProductFeedbackDraft(key, maxLength) : null;
    if (stored !== null) {
      setFeedbackState(stored);
    } else if (previousKey !== null) {
      // Switching between two real scopes must not carry text across scopes.
      setFeedbackState("");
    }
    // previousKey === null means the scope just resolved (e.g. session user ID
    // arrived after mount); keep whatever the operator already typed.
  }, [key, maxLength]);

  const setFeedback = useCallback(
    (next: string) => {
      setFeedbackState(next);
      if (key && hydratedKeyRef.current === key) {
        writeProductFeedbackDraft(key, next, maxLength);
      }
    },
    [key, maxLength],
  );

  const clearStoredDraft = useCallback(() => {
    if (key) removeProductFeedbackDraft(key);
  }, [key]);

  return { feedback, setFeedback, clearStoredDraft };
}
