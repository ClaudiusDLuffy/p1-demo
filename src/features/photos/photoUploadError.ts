/** Safe adapter message only; unknown operations remain eligible for same-intent reconciliation. */
export class PhotoUploadError extends Error {
  constructor(message: string, readonly retryable = true) {
    super(message);
    this.name = "PhotoUploadError";
  }
}
