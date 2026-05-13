import { anthropic } from "@ai-sdk/anthropic";

export const MODEL_ID = process.env.LIVEOPS_MODEL || "claude-sonnet-4-5";

export function model() {
  return anthropic(MODEL_ID);
}
