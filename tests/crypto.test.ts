import { describe, it, expect } from "vitest";
import {
  SecureChannel,
  createIdentity,
} from "../packages/crypto/src/index.ts";
function pair() {
  const a = createIdentity(),
    b = createIdentity();
  return {
    a,
    b,
    host: new SecureChannel("host", a, b.publicKey),
    device: new SecureChannel("device", b, a.publicKey),
  };
}
function handshake(host: SecureChannel, device: SecureChannel) {
  const proof = device.receive(host.hello()).reply!;
  const ready = host.receive(proof);
  expect(ready.ready).toBe(true);
  expect(device.receive(ready.reply!).ready).toBe(true);
}
describe("encrypted channel", () => {
  it("requires mutual authenticated handshake and hides application data", () => {
    const { host, device } = pair();
    expect(() => host.send("secret")).toThrow();
    handshake(host, device);
    const frame = host.send({ text: "private code" });
    expect(frame).not.toContain("private code");
    expect(device.receive(frame).data).toEqual({ text: "private code" });
  });
  it("rejects tampering, replay and wrong identities", () => {
    const { host, device, a } = pair();
    handshake(host, device);
    const frame = host.send("secret");
    expect(device.receive(frame).data).toBe("secret");
    expect(() => device.receive(frame)).toThrow();
    const wrong = new SecureChannel("device", createIdentity(), a.publicKey);
    expect(() => wrong.receive(host.hello())).toThrow();
    const parsed = JSON.parse(host.send("x"));
    parsed.cipher = parsed.cipher.slice(0, -8) + "AAAAAAAA";
    expect(() => device.receive(JSON.stringify(parsed))).toThrow();
  });
  it("does not accept a data frame from a previous connection", () => {
    const { host, device, a, b } = pair();
    handshake(host, device);
    const old = host.send("old");
    const h2 = new SecureChannel("host", a, b.publicKey),
      d2 = new SecureChannel("device", b, a.publicKey);
    handshake(h2, d2);
    expect(() => d2.receive(old)).toThrow();
    expect(d2.receive(h2.send("new")).data).toBe("new");
  });
  it("rejects reflection", () => {
    const { host, device } = pair();
    handshake(host, device);
    expect(() => host.receive(host.send("reflection"))).toThrow();
  });
});
