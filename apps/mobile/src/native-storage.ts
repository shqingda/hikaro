import * as SecureStore from "expo-secure-store";
import { openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
import type { MobileStorage } from "./controller";
import type { Intent } from "../../../packages/client-core/src/connection";
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
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS installation(id INTEGER PRIMARY KEY); CREATE TABLE IF NOT EXISTS intents(scope TEXT PRIMARY KEY, data TEXT NOT NULL);",
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
    },
    async clear(scope) {
      await (await db()).runAsync("DELETE FROM intents WHERE scope=?", scope);
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
