export interface RuntimeEvaluateResult<T = unknown> {
  result?: {
    value?: T;
    objectId?: string;
  };
  exceptionDetails?: {
    exception?: { description?: string };
    text?: string;
  };
}

export interface RuntimeEvaluateParams {
  expression: string;
  returnByValue: boolean;
  awaitPromise: boolean;
  replMode: boolean;
}

export function buildRuntimeEvaluateParams(
  expression: string,
  options: {
    returnByValue?: boolean;
    awaitPromise?: boolean;
  } = {},
): RuntimeEvaluateParams {
  return {
    expression,
    returnByValue: options.returnByValue ?? true,
    awaitPromise: options.awaitPromise ?? true,
    replMode: true,
  };
}

export function getRuntimeEvaluateError(
  result: RuntimeEvaluateResult,
): string | undefined {
  return result.exceptionDetails?.exception?.description
    || result.exceptionDetails?.text;
}
