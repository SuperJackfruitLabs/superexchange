/**
 * Carrying what the encryption machine asks to be sent.
 *
 * Ported from the AgentPod hub's `services/matrix-as/crypto-transport.ts`. `OlmMachine` performs
 * no network IO: it produces requests and expects the caller to carry them. This is that carrier,
 * and the whole of the boundary between `crypto.ts` and the homeserver.
 *
 * Every request goes out as the appservice asserting the speaker AND its device
 * (`?user_id=&device_id=`): crypto requests belong to a device, and the homeserver refuses one
 * that does not say which (`M_FORBIDDEN`, "device identified"; MSC4326).
 *
 * A request's body and its answer can carry key material, so an error names the endpoint, the
 * status and the Matrix `errcode`, never a body and never the token.
 */
import { MatrixClientError } from "./client.ts";

/** A request the machine produced, as this carrier reads it. */
export interface CryptoRequest {
  id: string;
  /** The binding's `RequestType`, by its number (an ambient const enum, not readable at runtime). */
  type: number;
  body: string;
  /** A `ToDeviceRequest` and a `RoomMessageRequest` carry these; others do not. */
  eventType?: string;
  txnId?: string;
  roomId?: string;
}

/** The binding's request types, by number, as its `index.d.ts` states them. */
export const REQUEST_TYPE = {
  KeysUpload: 0,
  KeysQuery: 1,
  KeysClaim: 2,
  ToDevice: 3,
  SignatureUpload: 4,
  RoomMessage: 5,
  KeysBackup: 6,
} as const;

const ENDPOINTS: Record<
  number,
  { name: string; method: "POST" | "PUT"; path: (r: CryptoRequest) => string }
> = {
  [REQUEST_TYPE.KeysUpload]: {
    name: "keys/upload",
    method: "POST",
    path: () => "/_matrix/client/v3/keys/upload",
  },
  [REQUEST_TYPE.KeysQuery]: {
    name: "keys/query",
    method: "POST",
    path: () => "/_matrix/client/v3/keys/query",
  },
  [REQUEST_TYPE.KeysClaim]: {
    name: "keys/claim",
    method: "POST",
    path: () => "/_matrix/client/v3/keys/claim",
  },
  [REQUEST_TYPE.ToDevice]: {
    name: "sendToDevice",
    method: "PUT",
    path: (r) =>
      `/_matrix/client/v3/sendToDevice/${encodeURIComponent(r.eventType ?? "m.room.encrypted")}/${encodeURIComponent(r.txnId ?? r.id)}`,
  },
  [REQUEST_TYPE.SignatureUpload]: {
    name: "keys/signatures/upload",
    method: "POST",
    path: () => "/_matrix/client/v3/keys/signatures/upload",
  },
  [REQUEST_TYPE.RoomMessage]: {
    name: "send",
    method: "PUT",
    path: (r) =>
      `/_matrix/client/v3/rooms/${encodeURIComponent(r.roomId ?? "")}/send/${encodeURIComponent(r.eventType ?? "m.room.message")}/${encodeURIComponent(r.txnId ?? r.id)}`,
  },
};

export interface CryptoTransportDeps {
  homeserverUrl: string;
  asToken: string;
  fetch?: typeof fetch;
}

export interface CryptoTransport {
  /** Send a request for `userId`'s `deviceId`; answers the homeserver's body, for the machine. */
  send(
    userId: string,
    deviceId: string,
    request: CryptoRequest,
  ): Promise<string>;
  /** Publish cross-signing keys (`/keys/device_signing/upload`), a bare body with no request id. */
  uploadSigningKeys(
    userId: string,
    deviceId: string,
    body: string,
  ): Promise<void>;
}

/**
 * The bytes to send for a request. Every type sends its body verbatim except `SignatureUpload`:
 * the binding hands back `{"signed_keys": {…}}`, while the endpoint takes that inner map as the
 * whole body and answers a bare `400 M_BAD_JSON` otherwise.
 */
function bodyFor(request: CryptoRequest): string {
  if (request.type !== REQUEST_TYPE.SignatureUpload) return request.body;
  const parsed = JSON.parse(request.body || "{}") as { signed_keys?: unknown };
  return JSON.stringify(parsed.signed_keys ?? parsed);
}

export function createCryptoTransport(
  deps: CryptoTransportDeps,
): CryptoTransport {
  const fetchFn = deps.fetch ?? fetch;
  const base = deps.homeserverUrl.replace(/\/+$/, "");

  async function post(
    endpoint: string,
    method: string,
    path: string,
    userId: string,
    deviceId: string,
    body: string,
  ): Promise<string> {
    const url = new URL(base + path);
    url.searchParams.set("user_id", userId);
    url.searchParams.set("device_id", deviceId);
    let response: Response;
    try {
      response = await fetchFn(url, {
        method,
        headers: {
          authorization: `Bearer ${deps.asToken}`,
          "content-type": "application/json",
        },
        body,
      });
    } catch {
      throw new MatrixClientError(endpoint, 0, null);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new MatrixClientError(endpoint, response.status, errcodeOf(text));
    }
    return text;
  }

  return {
    async send(userId, deviceId, request) {
      const route = ENDPOINTS[request.type];
      if (!route) {
        // Guessing would leave the machine waiting for an answer that never comes.
        throw new MatrixClientError(`crypto request ${request.type}`, 0, null);
      }
      return post(
        route.name,
        route.method,
        route.path(request),
        userId,
        deviceId,
        bodyFor(request),
      );
    },

    async uploadSigningKeys(userId, deviceId, body) {
      await post(
        "keys/device_signing/upload",
        "POST",
        "/_matrix/client/v3/keys/device_signing/upload",
        userId,
        deviceId,
        body,
      );
    },
  };
}

/** The `errcode` alone, never the body. */
function errcodeOf(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { errcode?: unknown };
    return typeof parsed.errcode === "string"
      ? parsed.errcode.slice(0, 64)
      : null;
  } catch {
    return null;
  }
}
