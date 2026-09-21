export class BrainHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "BrainHttpError";
    this.status = status;
    this.code = code;
  }
}

export function isBrainHttpError(error: unknown): error is BrainHttpError {
  return error instanceof BrainHttpError;
}

export function isNotImplemented(error: unknown): boolean {
  return isBrainHttpError(error) && (error.status === 404 || error.code === "not_found");
}
