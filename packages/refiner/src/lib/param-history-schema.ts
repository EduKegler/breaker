import { z } from "zod";

/**
 * Loose Zod schema for parameter-history.json validation.
 * Used by both the prompt builder and param-writer when loading history from disk.
 */
export const paramHistorySchema = z.object({
  iterations: z.array(z.object({}).passthrough()),
  neverWorked: z.array(z.unknown()),
  exploredRanges: z.record(z.string(), z.array(z.unknown())),
  pendingHypotheses: z.array(z.object({}).passthrough()),
  approaches: z.array(z.object({}).passthrough()).optional(),
  researchLog: z.array(z.object({}).passthrough()).optional(),
  testedCombinations: z.array(z.object({}).passthrough()).optional(),
  currentPhase: z.string().optional(),
  phaseStartIter: z.number().optional(),
});
