/**
 * Treaty's HTTP contracts for the two APIs this service calls, read from the installed
 * `@superjackfruitlabs/treaty-contracts`: SuperPipeline's decisions (`decisions.v1`) and the
 * organization plane's (`plane.v1`), with their cases.
 *
 * `checkedFetch` wraps a test fake: every request the client sends must reach an operation of the
 * API, and its body must be that operation's request. A request that does not is recorded in
 * `contractViolations`, which fails the test (`preload.ts`); the fake still answers it.
 */
import {
  matchRoute,
  openApi,
  validateRequest,
  validateResponse,
  type Api,
} from "@superjackfruitlabs/treaty-contracts";
import { loadInstalledBundle } from "@superjackfruitlabs/treaty-contracts/node";
import { contractViolations } from "./contract-violations.ts";

export const bundle = loadInstalledBundle();

export const DECISIONS = "schemas/http/superpipeline/decisions.v1.openapi.json";
export const PLANE = "schemas/http/accounts/plane.v1.openapi.json";

/** SuperPipeline's decisions API: the person writes and the service reads. */
export const decisions = openApi(bundle, DECISIONS);
/** The organization plane's API. */
export const plane = openApi(bundle, PLANE);

/** One part's cases, as a `*.cases.json` holds them. */
export interface PartCases {
  valid: Record<string, unknown>;
  invalid: { why: string; body: unknown }[];
}

/** An operation's request cases and its response cases by status. */
export interface OperationCases {
  request?: PartCases;
  responses?: Record<string, PartCases>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPartCases(value: unknown): value is PartCases {
  return (
    isObject(value) &&
    isObject(value.valid) &&
    Array.isArray(value.invalid) &&
    value.invalid.every(
      (c: unknown) => isObject(c) && typeof c.why === "string" && "body" in c,
    )
  );
}

function isOperationCases(value: unknown): value is OperationCases {
  if (!isObject(value)) return false;
  if (value.request !== undefined && !isPartCases(value.request)) return false;
  return (
    value.responses === undefined ||
    (isObject(value.responses) &&
      Object.values(value.responses).every(isPartCases))
  );
}

function partCases(path: string): PartCases {
  const file = bundle.files.get(path);
  if (!isPartCases(file)) throw new Error(`${path} holds no cases`);
  return file;
}

function casesOf(path: string): Record<string, OperationCases> {
  const operations: unknown = bundle.files.get(path);
  const found = isObject(operations) ? operations.operations : undefined;
  if (!isObject(found) || !Object.values(found).every(isOperationCases))
    throw new Error(`${path} holds no operation cases`);
  const out: Record<string, OperationCases> = {};
  for (const [id, c] of Object.entries(found))
    if (isOperationCases(c)) out[id] = c;
  return out;
}

export const decisionsCases = casesOf(
  "fixtures/http/superpipeline/decisions.v1.cases.json",
);
export const planeCases = casesOf("fixtures/http/accounts/plane.v1.cases.json");

/** `schemas/common/error.v1.json`'s cases: SuperPipeline's refusals. */
export const errorCases = partCases("fixtures/common/error.v1.cases.json");
/** `schemas/common/flat-error.v1.json`'s cases: the plane's refusals. */
export const flatErrorCases = partCases(
  "fixtures/common/flat-error.v1.cases.json",
);

/** The statuses an operation answers with a refusal. */
export function errorStatuses(api: Api, operationId: string): number[] {
  const op = api.operations.find((o) => o.id === operationId);
  if (!op) throw new Error(`${api.path} has no operation ${operationId}`);
  return Object.keys(op.responses)
    .filter((s) => /^[45]\d\d$/.test(s))
    .map(Number);
}

/** The error codes an operation lists (`x-treaty-error-codes`). */
export function errorCodes(api: Api, operationId: string): string[] {
  const op = api.operations.find((o) => o.id === operationId);
  if (!op) throw new Error(`${api.path} has no operation ${operationId}`);
  return op.errorCodes;
}

/** Whether the contract has `body` as an answer of `operationId` with `status`. */
export function accepts(
  api: Api,
  operationId: string,
  status: number,
  body: unknown,
): boolean {
  return validateResponse(bundle, api, operationId, status, body).valid;
}

/** A response body as the contract would have it; throws when it is not one. */
export function contracted(
  api: Api,
  operationId: string,
  status: number,
  body: unknown,
): unknown {
  const result = validateResponse(bundle, api, operationId, status, body);
  if (!result.valid)
    throw new Error(
      `${operationId} ${status} is not the contract's: ${result.errors.join("; ")}`,
    );
  return body;
}

/** The operation a request reaches, or a recorded violation and undefined. */
export function operationFor(
  api: Api,
  method: string,
  url: string,
): string | undefined {
  const path = new URL(url).pathname;
  const op = matchRoute(api, method, path);
  if (op === undefined)
    contractViolations.push(
      `${method} ${path} reaches no operation of ${api.path}`,
    );
  return op;
}

/** A request's URL, whatever form `fetch` was given it in. */
export function urlOf(input: URL | RequestInfo): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/** A request's JSON body: undefined when it has none, the text itself when it is not JSON. */
function bodyOf(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (body === undefined || body === null) return undefined;
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/** `fetch`, with every request checked against `api` first. */
export function checkedFetch(
  api: Api,
  fetch: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  const checked = async (input: URL | RequestInfo, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const op = operationFor(api, method, urlOf(input));
    if (op !== undefined) {
      const result = validateRequest(bundle, api, op, bodyOf(init));
      if (!result.valid)
        contractViolations.push(
          `${method} ${op}'s request is not the contract's: ${result.errors.join("; ")}`,
        );
    }
    return fetch(input, init);
  };
  return Object.assign(checked, {
    preconnect: globalThis.fetch.preconnect,
  });
}

/** The operation a request reaches, or undefined; records nothing. */
export function matchOperation(
  api: Api,
  method: string,
  url: string,
): string | undefined {
  return matchRoute(api, method, new URL(url).pathname);
}
