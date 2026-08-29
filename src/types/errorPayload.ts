import type { ParsedJob } from "../core/queue.js";

/** Resque-compatible representation of a failed job. */
export interface ErrorPayload {
  /** pg-boss job id, when the failure came from the job table. */
  id?: string;
  /** Worker that failed the job, or an empty string when unknown. */
  worker: string;
  /** Queue containing the job. */
  queue: string;
  /** Original encoded job payload. */
  payload: ParsedJob;
  /** Error class/name. */
  exception: string;
  /** Human-readable error message. */
  error: string;
  /** Stack frames, excluding the leading error message. */
  backtrace: string[];
  /** Date string matching node-resque's failed payload. */
  failed_at: string;
}
