import {
  PROBLEM_JSON_CONTENT_TYPE,
  billingWalletV1,
  type ProblemDetails,
} from '@aegisvolt/contracts';
import type { Response } from 'express';

import type { FieldError } from './validation.ts';

type ErrorCode = billingWalletV1.ErrorCode;

/** URI del tipo de problema (RFC 9457): estable y derivado del código. */
const problemType = (code: string): string => `urn:aegisvolt:problem:${code.toLowerCase()}`;

const titleFor = (code: string): string =>
  code
    .toLowerCase()
    .split('_')
    .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');

export function isKnownErrorCode(code: string): code is ErrorCode {
  return Object.hasOwn(billingWalletV1.ERROR_CODES, code);
}

export function buildProblem(input: {
  code: ErrorCode;
  detail?: string;
  instance?: string;
  correlationId?: string;
  errors?: readonly FieldError[];
}): ProblemDetails {
  return {
    type: problemType(input.code),
    title: titleFor(input.code),
    status: billingWalletV1.ERROR_CODES[input.code],
    code: input.code,
    ...(input.detail === undefined ? {} : { detail: input.detail }),
    ...(input.instance === undefined ? {} : { instance: input.instance }),
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
    ...(input.errors === undefined ? {} : { errors: [...input.errors] }),
  };
}

/** Escribe un problem+json salvo que la respuesta ya se haya enviado (p. ej. por timeout). */
export function sendProblem(res: Response, problem: ProblemDetails): void {
  if (res.headersSent) {
    return;
  }
  res.status(problem.status).type(PROBLEM_JSON_CONTENT_TYPE).send(JSON.stringify(problem));
}

/** Envía JSON salvo que la respuesta ya se haya enviado. */
export function sendJson(res: Response, status: number, body: unknown): void {
  if (res.headersSent) {
    return;
  }
  res.status(status).json(body);
}
