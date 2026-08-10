"use strict";

/**
 * /integration/health — checkIntegrationHealth(db). Pure logic against a
 * fake Firestore, no emulator or network involved.
 */

const { checkIntegrationHealth } = require("../index")._test;

function fakeDb({ healthPingThrows = false, subs = [], subsThrows = false } = {}) {
  return {
    collection(name) {
      if (name === "healthPing") {
        return {
          doc: () => ({
            async get() {
              if (healthPingThrows) throw new Error("firestore unavailable");
              return { exists: false };
            },
          }),
        };
      }
      if (name === "sharepointSubscriptions") {
        return {
          async get() {
            if (subsThrows) throw new Error("query failed");
            return { docs: subs.map((data) => ({ data: () => data })) };
          },
        };
      }
      throw new Error(`fakeDb: unexpected collection "${name}"`);
    },
  };
}

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();

describe("checkIntegrationHealth", () => {
  test("always reports documentStorageMode Firebase", async () => {
    const result = await checkIntegrationHealth(fakeDb());
    expect(result.documentStorageMode).toBe("Firebase");
  });

  test("firebaseReady is true when the healthPing read succeeds", async () => {
    const result = await checkIntegrationHealth(fakeDb());
    expect(result.firebaseReady).toBe(true);
  });

  test("firebaseReady is false when the healthPing read throws", async () => {
    const result = await checkIntegrationHealth(fakeDb({ healthPingThrows: true }));
    expect(result.firebaseReady).toBe(false);
  });

  test("no subscriptions: not connected, but healthy (nothing expired)", async () => {
    const result = await checkIntegrationHealth(fakeDb({ subs: [] }));
    expect(result.sharePointConnected).toBe(false);
    expect(result.webhooksHealthy).toBe(true);
  });

  test("an active subscription: connected and healthy", async () => {
    const result = await checkIntegrationHealth(
      fakeDb({ subs: [{ expirationDateTime: FUTURE }] })
    );
    expect(result.sharePointConnected).toBe(true);
    expect(result.webhooksHealthy).toBe(true);
  });

  test("only an expired subscription: not connected and not healthy", async () => {
    const result = await checkIntegrationHealth(
      fakeDb({ subs: [{ expirationDateTime: PAST }] })
    );
    expect(result.sharePointConnected).toBe(false);
    expect(result.webhooksHealthy).toBe(false);
  });

  test("one active and one expired: connected but not healthy", async () => {
    const result = await checkIntegrationHealth(
      fakeDb({ subs: [{ expirationDateTime: FUTURE }, { expirationDateTime: PAST }] })
    );
    expect(result.sharePointConnected).toBe(true);
    expect(result.webhooksHealthy).toBe(false);
  });

  test("sharepointSubscriptions query failure: not connected and not healthy", async () => {
    const result = await checkIntegrationHealth(fakeDb({ subsThrows: true }));
    expect(result.sharePointConnected).toBe(false);
    expect(result.webhooksHealthy).toBe(false);
  });

  test("Firestore fully down: firebaseReady false, SharePoint fields still fail-safe", async () => {
    const result = await checkIntegrationHealth(
      fakeDb({ healthPingThrows: true, subsThrows: true })
    );
    expect(result).toEqual({
      documentStorageMode: "Firebase",
      firebaseReady: false,
      sharePointConnected: false,
      webhooksHealthy: false,
    });
  });
});
