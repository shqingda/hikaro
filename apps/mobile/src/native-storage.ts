import * as SecureStore from "expo-secure-store";
import { openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
import type { MobileStorage } from "./controller";
import type { Intent } from "../../../packages/client-core/src/connection";
import { parseDraft } from "./composer";
const key = "hikaro.pairing.v1";
const options = {
  keychainService: "dev.hikaro.mobile",
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
export function nativeStorage(): MobileStorage {
  let database: Promise<SQLiteDatabase> | undefined;
  const db = () =>
    (database ??= (async () => {
      const value = await openDatabaseAsync("hikaro-mobile-state.sqlite");
      await value.execAsync(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS installation(id INTEGER PRIMARY KEY); CREATE TABLE IF NOT EXISTS intents(scope TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS mobile_drafts(scope TEXT NOT NULL, sessionId TEXT NOT NULL, data TEXT NOT NULL, updatedAt INTEGER NOT NULL, PRIMARY KEY(scope, sessionId));",
      );
      // Keychain can survive iOS uninstall. A new app installation does not silently
      // reuse an identity left by an old installation or a restored backup.
      if (
        !(await value.getFirstAsync("SELECT id FROM installation WHERE id=1"))
      ) {
        await SecureStore.deleteItemAsync(key, options);
        await value.runAsync("INSERT INTO installation VALUES(1)");
      }
      return value;
    })());
  return {
    async read() {
      await db();
      return SecureStore.getItemAsync(key, options);
    },
    async write(credential) {
      await db();
      await SecureStore.setItemAsync(key, credential, options);
    },
    async erase() {
      const value = await db();
      await SecureStore.deleteItemAsync(key, options);
      await value.runAsync("DELETE FROM intents");
      await value.runAsync("DELETE FROM mobile_drafts");
    },
    async clear(scope) {
      await (await db()).runAsync("DELETE FROM intents WHERE scope=?", scope);
      await (
        await db()
      ).runAsync("DELETE FROM mobile_drafts WHERE scope=?", scope);
    },
    drafts: {
      async load(scope, sessionId) {
        const value = await db();
        const row = sessionId
          ? await value.getFirstAsync<{ data: string }>(
              "SELECT data FROM mobile_drafts WHERE scope=? AND sessionId=?",
              scope,
              sessionId,
            )
          : await value.getFirstAsync<{ data: string }>(
              "SELECT data FROM mobile_drafts WHERE scope=? ORDER BY updatedAt DESC, rowid DESC LIMIT 1",
              scope,
            );
        return row ? parseDraft(row.data) : null;
      },
      async save(scope, record) {
        const data = JSON.stringify(record);
        parseDraft(data);
        await (
          await db()
        ).withExclusiveTransactionAsync(async (tx) => {
          await tx.runAsync(
            "INSERT INTO mobile_drafts(scope,sessionId,data,updatedAt) VALUES(?,?,?,?) ON CONFLICT(scope,sessionId) DO UPDATE SET data=excluded.data, updatedAt=excluded.updatedAt",
            scope,
            record.session.id,
            data,
            Date.now(),
          );
        });
      },
    },
    journal: (scope) => ({
      async load() {
        const row = await (
          await db()
        ).getFirstAsync<{ data: string }>(
          "SELECT data FROM intents WHERE scope=?",
          scope,
        );
        if (!row) return [];
        if (row.data.length > 65536) throw Error("Intent capacity exceeded");
        const value: unknown = JSON.parse(row.data);
        if (!Array.isArray(value) || value.length > 60)
          throw Error("Invalid intent journal");
        return value as Intent[];
      },
      async save(intents) {
        if (intents.length > 60) throw Error("Intent capacity exceeded");
        const data = JSON.stringify(intents);
        if (data.length > 65536) throw Error("Intent capacity exceeded");
        await (
          await db()
        ).withExclusiveTransactionAsync(async (tx) => {
          await tx.runAsync(
            "INSERT INTO intents(scope,data) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET data=excluded.data",
            scope,
            data,
          );
        });
      },
    }),
  };
}
