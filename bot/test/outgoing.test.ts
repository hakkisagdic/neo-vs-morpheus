import { describe, expect, it } from "vitest";
import { accountLogin, gameLogin } from "../src/uo/outgoing.ts";

describe("login packets", () => {
  it("fit the account name and password into 30-byte fields", () => {
    const packet = accountLogin("architect", "p".repeat(30));
    expect(packet.length).toBe(62);
    expect(packet[0]).toBe(0x80);
    expect(gameLogin(1, "architect", "p".repeat(30)).length).toBe(65);
  });

  it("refuse a password the field would cut", () => {
    expect(() => accountLogin("architect", "p".repeat(31))).toThrow(/password is 31 characters/);
    expect(() => gameLogin(1, "architect", "p".repeat(32))).toThrow(/at most 30/);
  });

  it("refuse an account name the field would cut", () => {
    expect(() => accountLogin("a".repeat(31), "secret")).toThrow(/account name/);
  });
});
