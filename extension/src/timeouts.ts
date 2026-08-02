export class OperationTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationTimeoutError";
  }
}

const TERMINATION_TIMEOUT_MS = 10000;

export function withTimeout<Result>(
  operation: Promise<Result>,
  timeoutMs: number,
  message: string,
): Promise<Result> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new OperationTimeoutError(message)),
      timeoutMs,
    );
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  });
}

export async function withTerminationOnTimeout<Result>(
  operation: Promise<Result>,
  timeoutMs: number,
  message: string,
  terminate: () => Promise<void>,
): Promise<Result> {
  try {
    return await withTimeout(operation, timeoutMs, message);
  } catch (error) {
    if (!(error instanceof OperationTimeoutError)) {
      throw error;
    }

    try {
      await withTimeout(
        terminate(),
        TERMINATION_TIMEOUT_MS,
        "Timed out terminating JavaScript execution",
      );
    } catch (terminationError) {
      const detail = terminationError instanceof Error
        ? terminationError.message
        : String(terminationError);
      throw new Error(`${message}; ${detail}`, { cause: terminationError });
    }
    throw error;
  }
}
