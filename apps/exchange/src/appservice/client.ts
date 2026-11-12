/**
 * The client-server API, spoken as this appservice's registration: every request carries the
 * `as_token`, and may assert one of the namespace's users with `?user_id=` (the spec's identity
 * assertion). What the board rooms need: `whoami`, registering a localpart with
 * `m.login.application_service` and naming it, creating a room, resolving an alias, inviting,
 * reading who has joined, and sending an event under a caller-chosen transaction id.
 *
 * `fetch` is injected so tests run without a homeserver. An error names the endpoint, the status
 * and the Matrix `errcode`, never the token and never the body the homeserver sent.
 */

export interface ClientDeps {
  /** Where the homeserver's client-server API answers. */
  homeserverUrl: string;
  /** The homeserver's server name, the part of a user id after the colon. */
  serverName: string;
  /** The registration's `as_token`. */
  asToken: string;
  fetch?: typeof fetch;
}

export class MatrixClientError extends Error {
  constructor(
    readonly endpoint: string,
    readonly status: number,
    readonly errcode: string | null,
  ) {
    super(`${endpoint} answered ${status}${errcode ? ` ${errcode}` : ""}`);
    this.name = "MatrixClientError";
  }
}

/** A localpart the spec allows in a user id (lowercase, historical characters excluded). */
const LOCALPART = /^[a-z0-9._=\-/+]{1,200}$/;

export interface AppserviceClient {
  /**
   * Who the homeserver says this token is, or the asserted user when `asUser` is given. Throws
   * when the homeserver answers for somebody else.
   */
  whoami(asUser?: string): Promise<{ userId: string }>;
  /**
   * Register a user in this appservice's namespace. `created` is false when it already existed
   * (`M_USER_IN_USE`), which is not an error: registration is idempotent here.
   */
  register(localpart: string): Promise<{ userId: string; created: boolean }>;
  /** Set a user's display name, as that user. */
  setDisplayName(userId: string, displayName: string): Promise<void>;
  /**
   * Create a private room as `asUser`, under the alias localpart `aliasLocalpart`. An alias already
   * taken throws with `M_ROOM_IN_USE`. `encrypted` puts `m.room.encryption` (Megolm) in the
   * room's initial state; without it the room is made in plaintext.
   */
  createRoom(asUser: string, options: CreateRoomOptions): Promise<string>;
  /** The room a full alias (`#localpart:server`) points at, or null when it points nowhere. */
  resolveAlias(alias: string): Promise<string | null>;
  /** Invite `userId` into a room, as `asUser`. */
  invite(asUser: string, roomId: string, userId: string): Promise<void>;
  /** The users who have joined a room, asked as `asUser` (who must be in it). */
  joinedMembers(asUser: string, roomId: string): Promise<string[]>;
  /**
   * Send an event as `asUser` under transaction id `txnId`, answering its event id. The
   * homeserver answers a repeated transaction id with the first send's event id rather than
   * sending again, so a retry under the same id is idempotent.
   */
  sendEvent(
    asUser: string,
    roomId: string,
    eventType: string,
    txnId: string,
    content: Record<string, unknown>,
  ): Promise<string>;
}

export interface CreateRoomOptions {
  aliasLocalpart: string;
  name: string;
  topic: string;
  /** Invited on creation. */
  invite: string[];
  /** The users given a power level other than the preset's, by id. */
  powerLevels?: Record<string, number>;
  encrypted: boolean;
}

/** The state event that turns a room's end-to-end encryption on. */
export const ROOM_ENCRYPTION_STATE = {
  type: "m.room.encryption",
  state_key: "",
  content: { algorithm: "m.megolm.v1.aes-sha2" },
} as const;

export function createClient(deps: ClientDeps): AppserviceClient {
  const fetchFn = deps.fetch ?? fetch;
  const base = deps.homeserverUrl.replace(/\/+$/, "");

  async function call(
    endpoint: string,
    path: string,
    init: {
      method: string;
      body?: unknown;
      query?: Record<string, string>;
      /** Assert this namespace user (`?user_id=`). */
      asUser?: string;
    },
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(init.query ?? {}))
      url.searchParams.set(k, v);
    if (init.asUser !== undefined) url.searchParams.set("user_id", init.asUser);
    const headers: Record<string, string> = {
      authorization: `Bearer ${deps.asToken}`,
    };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await fetchFn(url, {
        method: init.method,
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch {
      throw new MatrixClientError(endpoint, 0, null);
    }
    let json: Record<string, unknown> = {};
    try {
      const parsed: unknown = await response.json();
      if (typeof parsed === "object" && parsed !== null)
        json = parsed as Record<string, unknown>;
    } catch {
      // A body that is not JSON reads as empty; the status still says what happened.
    }
    return { status: response.status, json };
  }

  const errcodeOf = (json: Record<string, unknown>) =>
    typeof json.errcode === "string" ? json.errcode.slice(0, 64) : null;

  /** The answer's JSON when it is a 2xx; otherwise a MatrixClientError. */
  async function ok(
    endpoint: string,
    path: string,
    init: Parameters<typeof call>[2],
  ): Promise<Record<string, unknown>> {
    const { status, json } = await call(endpoint, path, init);
    if (status < 200 || status >= 300)
      throw new MatrixClientError(endpoint, status, errcodeOf(json));
    return json;
  }

  const room = (roomId: string) =>
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}`;

  return {
    async whoami(asUser) {
      const endpoint = "whoami";
      const { status, json } = await call(
        endpoint,
        "/_matrix/client/v3/account/whoami",
        { method: "GET", ...(asUser ? { query: { user_id: asUser } } : {}) },
      );
      if (status !== 200)
        throw new MatrixClientError(endpoint, status, errcodeOf(json));
      const userId = json.user_id;
      if (typeof userId !== "string")
        throw new MatrixClientError(endpoint, status, null);
      if (asUser !== undefined && userId !== asUser) {
        throw new MatrixClientError(endpoint, status, "M_WRONG_USER");
      }
      return { userId };
    },

    async register(localpart) {
      const endpoint = "register";
      if (!LOCALPART.test(localpart)) {
        throw new MatrixClientError(endpoint, 0, "M_INVALID_USERNAME");
      }
      const { status, json } = await call(
        endpoint,
        "/_matrix/client/v3/register",
        {
          method: "POST",
          body: {
            type: "m.login.application_service",
            username: localpart,
            inhibit_login: true,
          },
        },
      );
      if (status === 200 && typeof json.user_id === "string") {
        return { userId: json.user_id, created: true };
      }
      const errcode = errcodeOf(json);
      if (status === 400 && errcode === "M_USER_IN_USE") {
        return { userId: `@${localpart}:${deps.serverName}`, created: false };
      }
      throw new MatrixClientError(endpoint, status, errcode);
    },

    async setDisplayName(userId, displayName) {
      await ok(
        "displayname",
        `/_matrix/client/v3/profile/${encodeURIComponent(userId)}/displayname`,
        { method: "PUT", asUser: userId, body: { displayname: displayName } },
      );
    },

    async createRoom(asUser, options) {
      const endpoint = "createRoom";
      const json = await ok(endpoint, "/_matrix/client/v3/createRoom", {
        method: "POST",
        asUser,
        body: {
          room_alias_name: options.aliasLocalpart,
          name: options.name,
          topic: options.topic,
          preset: "private_chat",
          visibility: "private",
          invite: options.invite,
          initial_state: options.encrypted ? [ROOM_ENCRYPTION_STATE] : [],
          ...(options.powerLevels
            ? { power_level_content_override: { users: options.powerLevels } }
            : {}),
        },
      });
      if (typeof json.room_id !== "string" || json.room_id === "")
        throw new MatrixClientError(endpoint, 200, null);
      return json.room_id;
    },

    async resolveAlias(alias) {
      const endpoint = "directory";
      const { status, json } = await call(
        endpoint,
        `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
        { method: "GET" },
      );
      if (status === 404) return null;
      if (status !== 200)
        throw new MatrixClientError(endpoint, status, errcodeOf(json));
      return typeof json.room_id === "string" && json.room_id !== ""
        ? json.room_id
        : null;
    },

    async invite(asUser, roomId, userId) {
      await ok("invite", `${room(roomId)}/invite`, {
        method: "POST",
        asUser,
        body: { user_id: userId },
      });
    },

    async joinedMembers(asUser, roomId) {
      const json = await ok(
        "joined_members",
        `${room(roomId)}/joined_members`,
        {
          method: "GET",
          asUser,
        },
      );
      const joined = json.joined;
      return typeof joined === "object" && joined !== null
        ? Object.keys(joined)
        : [];
    },

    async sendEvent(asUser, roomId, eventType, txnId, content) {
      const endpoint = "send";
      const json = await ok(
        endpoint,
        `${room(roomId)}/send/${encodeURIComponent(eventType)}/${encodeURIComponent(txnId)}`,
        { method: "PUT", asUser, body: content },
      );
      if (typeof json.event_id !== "string" || json.event_id === "")
        throw new MatrixClientError(endpoint, 200, null);
      return json.event_id;
    },
  };
}
