import { z } from "zod";
import { RowboatApiConfig } from "@x/shared/dist/rowboat-account.js";

/** Hosted Rowboat /v1/config is gone. Callers must treat this as unavailable. */
export async function getRowboatConfig(): Promise<z.infer<typeof RowboatApiConfig>> {
  throw new Error("Hosted Rowboat API removed — use local BYOK keys (models, Composio, Google OAuth).");
}