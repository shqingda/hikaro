import { it, expect } from "vitest";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  symlink,
  stat,
} from "node:fs/promises";
import { X509Certificate } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile, fork, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer } from "node:net";
import WebSocket from "ws";
import { RemoteClient, parsePairing } from "../packages/remote/src/client.ts";
import { protocolVersion } from "../packages/protocol/src/contracts.ts";
import { openLab, lockLab } from "../scripts/mobile-lab-files.mjs";

it("keeps lab secrets private and refuses symlinks or an unowned directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "hikaro-lab-files-"));
  try {
    const lab = await openLab(join(root, "owned"));
    await lab.write("secret.json", { private: "test-only" });
    expect((await stat(join(lab.directory, "secret.json"))).mode & 0o777).toBe(
      0o600,
    );
    await symlink(lab.directory, join(root, "linked"));
    await expect(openLab(join(root, "linked"))).rejects.toThrow(
      /private|owned|symbolic/i,
    );
    await symlink(
      join(lab.directory, "secret.json"),
      join(lab.directory, "link.json"),
    );
    await expect(lab.read("link.json")).rejects.toThrow();
    await expect(openLab(root)).rejects.toThrow(/owned|empty/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("prevents simultaneous lab owners and releases the lock on shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "hikaro-lab-lock-"));
  try {
    const lab = await openLab(root);
    const release = await lockLab(lab);
    await expect(lockLab(lab)).rejects.toThrow(/running/i);
    await release();
    await (
      await lockLab(lab)
    )();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("requires confirmation over real TLS, defaults to task control and preserves explicit grants across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "hikaro-lab-transport-"));
  let child: ChildProcess | undefined;
  let remote: RemoteClient | undefined;
  try {
    const lab = await openLab(root);
    const exec = promisify(execFile);
    const certConfig = join(root, "cert.cnf");
    await writeFile(
      certConfig,
      `[req]
prompt = no
distinguished_name = dn
[dn]
CN = localhost
[ca_ext]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
[server_ext]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = IP:127.0.0.1,DNS:localhost
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
`,
      { mode: 0o600 },
    );
    await exec("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(root, "ca-key.pem"),
      "-out",
      join(root, "ca.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=Hikaro M0 Test CA",
      "-config",
      certConfig,
      "-extensions",
      "ca_ext",
    ]);
    await exec("openssl", [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(root, "server-key.pem"),
      "-out",
      join(root, "server.csr"),
      "-config",
      certConfig,
    ]);
    await exec("openssl", [
      "x509",
      "-req",
      "-in",
      join(root, "server.csr"),
      "-CA",
      join(root, "ca.pem"),
      "-CAkey",
      join(root, "ca-key.pem"),
      "-CAcreateserial",
      "-days",
      "1",
      "-extfile",
      certConfig,
      "-extensions",
      "server_ext",
      "-out",
      join(root, "server.pem"),
    ]);
    const ca = new X509Certificate(await readFile(join(root, "ca.pem")));
    const leaf = new X509Certificate(await readFile(join(root, "server.pem")));
    expect(ca.ca).toBe(true);
    expect(leaf.ca).toBe(false);
    expect(leaf.checkIssued(ca) && leaf.verify(ca.publicKey)).toBe(true);
    expect(leaf.checkIP("127.0.0.1")).toBe("127.0.0.1");
    await writeFile(join(root, "server.pem"), leaf.toString() + ca.toString());
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((done) => server.close(() => done()));
    child = fork(resolve("scripts/mobile-fixture.mjs"), [], {
      execArgv: ["--import", "tsx"],
      env: {
        ...process.env,
        HIKARO_MOBILE_FIXTURE_CA: join(root, "ca.pem"),
        HIKARO_MOBILE_FIXTURE_DIR: root,
        HIKARO_MOBILE_LAB_PORT: String(port),
      },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    let diagnostic = "";
    child.stderr!.on("data", (data) => {
      diagnostic = (diagnostic + data).slice(-2000);
    });
    const events: any[] = [];
    child.on("message", (event) => events.push(event));
    let nextId = 0;
    async function until(check: () => boolean, ms = 15000) {
      const deadline = Date.now() + ms;
      while (!check()) {
        if (child!.exitCode !== null) throw Error(`Lab exited: ${diagnostic}`);
        if (Date.now() > deadline) throw Error(`Lab timeout: ${diagnostic}`);
        await new Promise((done) => setTimeout(done, 20));
      }
    }
    async function command(command: string) {
      const id = ++nextId;
      child!.send({ id, command });
      await until(() => events.some((event) => event.id === id));
      const response = events.find((event) => event.id === id);
      if (response.error) throw Error(response.error);
      return response.result;
    }
    await until(() => events.some((event) => event.type === "ready"));
    const initial = events.find((event) => event.type === "ready");
    const uri = await readFile(join(root, "pairing.txt"), "utf8");
    const pairing = parsePairing(uri);
    let connected = false;
    remote = new RemoteClient(pairing, {
      socket: (url, protocols) =>
        new WebSocket(url, protocols, { ca: requireCa }) as any,
      reconnectMs: 50,
    });
    const requireCa = await readFile(join(root, "ca.pem"));
    remote.subscribe((frame) => {
      if (frame.type === "connection") connected = frame.status === "connected";
    });
    remote.connect();
    await until(() => events.some((event) => event.type === "pending"));
    expect(connected).toBe(false);
    await expect(command("grant")).rejects.toThrow(/confirm/i);
    expect((await command("allow")).confirmed).toBe(true);
    await until(() => connected);
    await remote.request("hello", { protocolVersions: [protocolVersion] });
    expect(await remote.request("session.list")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: initial.sessionId }),
      ]),
    );
    await remote.request("session.resume", { sessionId: initial.sessionId });
    expect((await remote.request("session.current")).sessionRole).toBe(
      "control",
    );
    // Explicit view remains a restriction on the paired-phone default.
    await command("grant");
    expect(await remote.request("session.list")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: initial.sessionId }),
      ]),
    );
    await remote.request("session.resume", { sessionId: initial.sessionId });
    await expect(
      remote.request("prompt", { text: "must be denied" }),
    ).rejects.toThrow();
    await command("offline");
    await until(() => !connected);
    await command("update");
    await command("online");
    await until(() => connected);
    await remote.request("hello", { protocolVersions: [protocolVersion] });
    expect((await remote.request("session.current")).session.id).toBe(
      initial.sessionId,
    );
    remote.close();
    await command("restart");
    expect((await lab.read("lab.json"))?.deviceId).toBe(pairing.deviceId);
    remote = new RemoteClient(pairing, {
      socket: (url, protocols) =>
        new WebSocket(url, protocols, { ca: requireCa }) as any,
    });
    connected = false;
    remote.subscribe((frame) => {
      if (frame.type === "connection") connected = frame.status === "connected";
    });
    remote.connect();
    await until(() => connected);
    await remote.request("hello", { protocolVersions: [protocolVersion] });
    expect((await remote.request("session.current")).session.id).toBe(
      initial.sessionId,
    );
    const history = await remote.request("messages.read", { limit: 20 });
    expect(JSON.stringify(history)).toContain("断线期间的新增结果");
    await command("unshare");
    expect(await remote.request("session.list")).toEqual([]);
    await command("revoke");
    await until(() => !connected);
  } finally {
    remote?.close();
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    await rm(root, { recursive: true, force: true });
  }
}, 45000);
