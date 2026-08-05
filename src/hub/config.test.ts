import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_HUB_PORT,
  defaultHubConfigPath,
  expandHomePath,
  isLoopbackHost,
  localHubConfig,
  parseHubConfig,
} from "./config";

const USER = { name: "tobias", passwordHash: "$argon2id$fake" };

describe("parseHubConfig", () => {
  test("applies defaults for a minimal config", () => {
    const config = parseHubConfig({ users: [USER] });
    expect(config.port).toBe(DEFAULT_HUB_PORT);
    expect(config.host).toBe("127.0.0.1");
    expect(config.tls).toBeNull();
    expect(config.users).toEqual([USER]);
    // File-loaded configs are never local mode.
    expect(config.local).toBe(false);
  });

  test("accepts a full config and expands ~ paths", () => {
    const config = parseHubConfig({
      port: 4433,
      host: "0.0.0.0",
      tls: { cert: "~/certs/fullchain.pem", key: "~/certs/key.pem" },
      users: [USER],
      stateDir: "~/state",
    });
    expect(config.port).toBe(4433);
    expect(config.tls?.cert).toBe(path.join(os.homedir(), "certs/fullchain.pem"));
    expect(config.stateDir).toBe(path.join(os.homedir(), "state"));
  });

  test("rejects the removed workspacesDir key by name", () => {
    expect(() => parseHubConfig({ users: [USER], workspacesDir: "~/workspaces" })).toThrow(
      /'workspacesDir' was removed/,
    );
  });

  test("refuses a non-loopback host without TLS", () => {
    expect(() => parseHubConfig({ host: "0.0.0.0", users: [USER] })).toThrow(/refusing to listen on non-loopback/);
    // Loopback plain HTTP stays allowed (behind-your-own-proxy mode).
    expect(() => parseHubConfig({ host: "127.0.0.1", users: [USER] })).not.toThrow();
    expect(() => parseHubConfig({ host: "localhost", users: [USER] })).not.toThrow();
  });

  test("requires a non-empty users list with names and hashes", () => {
    expect(() => parseHubConfig({})).toThrow(/users must be a non-empty array/);
    expect(() => parseHubConfig({ users: [] })).toThrow(/users must be a non-empty array/);
    expect(() => parseHubConfig({ users: [{ name: "" }] })).toThrow(/non-empty name/);
    expect(() => parseHubConfig({ users: [{ name: "a" }] })).toThrow(/passwordHash/);
    expect(() => parseHubConfig({ users: [USER, USER] })).toThrow(/duplicate user name/);
  });

  test("rejects malformed port and tls shapes", () => {
    expect(() => parseHubConfig({ port: 0, users: [USER] })).toThrow(/invalid port/);
    expect(() => parseHubConfig({ port: "4700", users: [USER] })).toThrow(/invalid port/);
    expect(() => parseHubConfig({ tls: { cert: "/x.pem" }, users: [USER] })).toThrow(/both cert and key/);
  });
});

describe("localHubConfig", () => {
  test("builds a loopback, userless, TLS-free local-mode config", () => {
    const config = localHubConfig({ port: 0 });
    expect(config.local).toBe(true);
    expect(config.host).toBe("127.0.0.1");
    expect(config.tls).toBeNull();
    expect(config.users).toEqual([]);
    expect(config.port).toBe(0);
  });
});

describe("path helpers", () => {
  test("expandHomePath expands only leading ~", () => {
    expect(expandHomePath("~/x")).toBe(path.join(os.homedir(), "x"));
    expect(expandHomePath("/abs/x")).toBe("/abs/x");
    expect(expandHomePath("rel/~x")).toBe("rel/~x");
  });

  test("defaultHubConfigPath honors XDG_CONFIG_HOME", () => {
    expect(defaultHubConfigPath({ XDG_CONFIG_HOME: "/custom" })).toBe("/custom/uatu/hub.json");
    expect(defaultHubConfigPath({})).toBe(path.join(os.homedir(), ".config", "uatu", "hub.json"));
  });

  test("isLoopbackHost recognizes loopback names", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("homebox.lan")).toBe(false);
  });
});
