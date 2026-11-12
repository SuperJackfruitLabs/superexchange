/**
 * The speaker's encryption device, and encrypted events still waiting for their key.
 *
 * `openStore` in index.ts composes these with the other table groups over one database.
 */
import type { Database } from "bun:sqlite";
import type { Store } from "./model.ts";

export type CryptoQueries = Pick<
  Store,
  | "cryptoDevice"
  | "recordCryptoDevice"
  | "forgetCryptoDevice"
  | "parkPendingDecrypt"
  | "pendingDecrypts"
  | "claimPendingDecrypt"
>;

export function cryptoQueries(
  db: Database,
  stamp: () => string,
): CryptoQueries {
  return {
    cryptoDevice(userId) {
      const row = db
        .query<
          { device_id: string },
          [string]
        >("SELECT device_id FROM crypto_devices WHERE user_id = ?")
        .get(userId);
      return row?.device_id ?? null;
    },

    recordCryptoDevice(userId, deviceId) {
      db.query(
        "INSERT INTO crypto_devices (user_id, device_id, created_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO NOTHING",
      ).run(userId, deviceId, stamp());
      return (
        db
          .query<
            { device_id: string },
            [string]
          >("SELECT device_id FROM crypto_devices WHERE user_id = ?")
          .get(userId)?.device_id ?? deviceId
      );
    },

    forgetCryptoDevice(userId) {
      db.query("DELETE FROM crypto_devices WHERE user_id = ?").run(userId);
    },

    parkPendingDecrypt(eventId, roomId, event, max) {
      return db.transaction(() => {
        const inserted = db
          .query(
            "INSERT INTO pending_decrypts (event_id, room_id, event, first_seen_at) VALUES (?, ?, ?, ?) ON CONFLICT (event_id) DO NOTHING",
          )
          .run(eventId, roomId, JSON.stringify(event), stamp()).changes;
        if (inserted !== 1) return false;
        db.query(
          `DELETE FROM pending_decrypts WHERE event_id IN (
             SELECT event_id FROM pending_decrypts
             ORDER BY first_seen_at DESC, event_id DESC LIMIT -1 OFFSET ?
           )`,
        ).run(max);
        return true;
      })();
    },

    pendingDecrypts() {
      return db
        .query<
          {
            event_id: string;
            room_id: string;
            event: string;
            first_seen_at: string;
          },
          []
        >("SELECT * FROM pending_decrypts ORDER BY first_seen_at, event_id")
        .all()
        .map((row) => ({
          eventId: row.event_id,
          roomId: row.room_id,
          event: JSON.parse(row.event) as Record<string, unknown>,
          firstSeenAt: row.first_seen_at,
        }));
    },

    claimPendingDecrypt(eventId) {
      return (
        db.query("DELETE FROM pending_decrypts WHERE event_id = ?").run(eventId)
          .changes === 1
      );
    },
  };
}
