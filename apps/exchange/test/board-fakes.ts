/**
 * Fetch-injected fakes for board chat's neighbours: the homeserver, the organization plane and
 * SuperPipeline's person routes, plus a signed relay delivery. Each records what it was asked.
 */
import {
  SIGNATURE_HEADER,
  signDelivery,
  toBinary,
} from "@superjackfruitlabs/treaty-cloudevents";
import { RELAY_SECRET } from "./helpers.ts";

export const SERVER = "staging-matrix.example.test";
export const SPEAKER = `@superexchange_board:${SERVER}`;
export const ANA = `@ana:${SERVER}`;
export const AGENT = `@agent_cody:${SERVER}`;
export const STRANGER = `@stranger:${SERVER}`;
export const AS_TOKEN = "as-token-for-tests";
export const PLANE_URL = "http://accounts.test";
export const SP_URL = "http://superpipeline.test";
export const CREDENTIAL = {
  id: `svc_${"0c".repeat(10)}`,
  secret: "plane-secret-for-cards",
};

/** A JWT-shaped token; this service only reads its claims. */
export function jwt(claims: Record<string, unknown>): string {
  const part = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${part({ alg: "EdDSA" })}.${part(claims)}.signature`;
}

/** A homeserver for sends, joined_members and invites; a repeated transaction id is the first event. */
export function fakeHomeserver() {
  const sent: Array<{
    roomId: string;
    type: string;
    txnId: string;
    content: Record<string, unknown>;
  }> = [];
  const txns = new Map<string, string>();
  const created: Array<Record<string, unknown>> = [];
  let failing = false;
  const fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname);
    if (path.endsWith("/joined_members"))
      return Response.json({ joined: { [SPEAKER]: {} } });
    if (path.endsWith("/invite")) return Response.json({});
    if (path === "/_matrix/client/v3/register")
      return Response.json({ user_id: SPEAKER });
    if (path.startsWith("/_matrix/client/v3/profile/"))
      return Response.json({});
    if (path === "/_matrix/client/v3/createRoom") {
      created.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ room_id: `!made${created.length}:${SERVER}` });
    }
    const m =
      /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/send\/([^/]+)\/(.+)$/.exec(path);
    if (!m)
      return Response.json({ errcode: "M_UNRECOGNIZED" }, { status: 404 });
    if (failing)
      return Response.json({ errcode: "M_UNKNOWN" }, { status: 500 });
    const [, roomId, type, txnId] = m as unknown as string[];
    const key = `${url.searchParams.get("user_id")}|${txnId}`;
    const known = txns.get(key);
    if (known) return Response.json({ event_id: known });
    const eventId = `$sent${sent.length + 1}`;
    txns.set(key, eventId);
    sent.push({
      roomId: roomId as string,
      type: type as string,
      txnId: txnId as string,
      content: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return Response.json({ event_id: eventId });
  }) as typeof globalThis.fetch;
  return {
    fetch,
    sent,
    created,
    fail: (on: boolean) => {
      failing = on;
    },
  };
}

/** The organization plane: Ana is a person, Cody an agent, the stranger nobody. */
export function fakePlane() {
  const state = { down: false };
  const identities: Record<string, string> = {
    [ANA]: "prn_ana",
    [AGENT]: "prn_cody",
  };
  const principals: Record<string, Record<string, unknown>> = {
    prn_ana: {
      id: "prn_ana",
      kind: "human",
      handle: "ana",
      displayName: "Ana",
    },
    prn_cody: { id: "prn_cody", kind: "agent", handle: "cody" },
  };
  const fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    if (state.down) throw new TypeError(`connect ECONNREFUSED ${PLANE_URL}`);
    const path = decodeURIComponent(new URL(String(input)).pathname);
    const identity = /^\/api\/identities\/matrix\/(.+)$/.exec(path);
    if (identity) {
      const id = identities[identity[1] as string];
      return id
        ? Response.json({ principalId: id })
        : Response.json({ error: "not_found" }, { status: 404 });
    }
    const principal = /^\/api\/principals\/(.+)$/.exec(path);
    if (principal) {
      const p = principals[principal[1] as string];
      return p
        ? Response.json(p)
        : Response.json({ error: "not_found" }, { status: 404 });
    }
    if (path === "/api/token/assertion") {
      const body = JSON.parse(String(init?.body)) as {
        identity: { externalId: string };
      };
      return Response.json({
        access_token: jwt({ sub: identities[body.identity.externalId] }),
        expires_in: 60,
      });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, state, identities };
}

/** SuperPipeline's person routes; each answers what `next` says. */
export function fakeBoard() {
  const calls: Array<{
    path: string;
    authorization: string | null;
    body: Record<string, unknown>;
  }> = [];
  const state: { next: { status: number; code?: string } | "unreachable" } = {
    next: { status: 200 },
  };
  const fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({
      path: decodeURIComponent(new URL(String(input)).pathname),
      authorization: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const next = state.next;
    if (next === "unreachable") throw new TypeError("fetch failed");
    if (next.status === 200) return Response.json({ ok: true });
    return Response.json(
      { error: { code: next.code } },
      { status: next.status },
    );
  }) as typeof globalThis.fetch;
  return { fetch, calls, state };
}

/** A relay delivery of `data` as CloudEvents type `type`, signed with the test secret. */
export async function relayRequest(data: unknown, type: string) {
  const body = new TextEncoder().encode(JSON.stringify(data));
  const message = toBinary(
    {
      attributes: {
        id: "evt-card",
        source: "superpipeline",
        specversion: "1.0",
        type,
        datacontenttype: "application/json",
      },
      data: body,
    },
    "http",
  );
  return new Request("http://exchange/v1/relay/events", {
    method: "POST",
    headers: {
      ...message.headers,
      [SIGNATURE_HEADER]: await signDelivery(
        RELAY_SECRET,
        "evt-card",
        body,
        Date.now(),
      ),
    },
    body: body as BodyInit,
  });
}
