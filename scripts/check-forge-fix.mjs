// Compare the installed backport with an isolated, hash-verified original.
// Candidate: https://github.com/digitalbazaar/forge/pull/1152 (ceba344).
import { createRequire } from "node:module";
import { mkdtemp, cp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import assert from "node:assert/strict";
const require = createRequire(
  process.argv[2] ? resolve(process.argv[2]) : import.meta.url,
);
const runtime = createRequire(require.resolve("@anthropic-ai/sandbox-runtime"));
const source = dirname(runtime.resolve("node-forge/package.json"));
const metadata = JSON.parse(
  await readFile(join(source, "package.json"), "utf8"),
);
assert.equal(
  metadata.version,
  "1.4.0",
  "Reassess candidate against changed upstream version",
);
const temporary = await mkdtemp(join(tmpdir(), "hikaro-forge-fix-"));
try {
  await cp(source, temporary, { recursive: true });
  const file = join(temporary, "lib/rsa.js");
  const patched = await readFile(file, "utf8");
  assert.equal(
    createHash("sha256").update(patched).digest("hex"),
    "447c5441cea1b125e23661d7e27a8b1759cc3400241c0013b2d034b4ee1dbf50",
  );
  const original = patched.replace(
    "obj.value.length !== 2 ||\n            obj.value[0].value.length !== (('parameters' in capture) ? 2 : 1)) {",
    "obj.value.length !== 2) {",
  );
  assert.equal(
    createHash("sha256").update(original).digest("hex"),
    "fd4740238145ec26470eb3f06a627c72039538ce1307dbdce40521f94dfd0a50",
  );
  await writeFile(file, original);
  const baseline = createRequire(join(temporary, "package.json"))(
    "./lib/index.js",
  );
  const candidate = runtime("node-forge");
  // Locally generated test key, never an external key or real credential.
  const keys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 65537,
  });
  const privatePem = keys.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const publicPem = keys.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const signer = baseline.pki.privateKeyFromPem(privatePem);
  const oldVerifier = baseline.pki.publicKeyFromPem(publicPem);
  const newVerifier = candidate.pki.publicKeyFromPem(publicPem);
  const a = baseline.asn1;
  const message = Buffer.from("hikaro local regression fixture");
  const cases = [];
  for (const hash of ["sha1", "sha256", "sha384", "sha512"])
    for (const parameters of [false, true]) {
      const digest = createHash(hash).update(message).digest();
      const node = (type, constructed, value) =>
        a.create(a.Class.UNIVERSAL, type, constructed, value);
      const algorithm = [
        node(a.Type.OID, false, a.oidToDer(baseline.pki.oids[hash]).getBytes()),
      ];
      if (parameters) algorithm.push(node(a.Type.NULL, false, ""));
      const sign = (extra) =>
        signer.sign(
          a
            .toDer(
              node(a.Type.SEQUENCE, true, [
                node(a.Type.SEQUENCE, true, [...algorithm, ...extra]),
                node(a.Type.OCTETSTRING, false, digest.toString("binary")),
              ]),
            )
            .getBytes(),
          "NONE",
        );
      const valid = sign([]);
      assert.equal(oldVerifier.verify(digest.toString("binary"), valid), true);
      assert.equal(newVerifier.verify(digest.toString("binary"), valid), true);
      const malformed = sign([
        node(a.Type.OCTETSTRING, false, "unexpected extra field"),
      ]);
      assert.equal(
        oldVerifier.verify(digest.toString("binary"), malformed),
        true,
      );
      assert.throws(
        () => newVerifier.verify(digest.toString("binary"), malformed),
        /DigestInfo/,
      );
      assert.equal(
        verify(hash, message, keys.publicKey, Buffer.from(malformed, "binary")),
        false,
      );
      cases.push({
        hash,
        parameters,
        validAccepted: true,
        baselineAcceptedMalformed: true,
        candidateRejectedMalformed: true,
        nativeRejectedMalformed: true,
      });
    }
  const report = {
    status: "passed",
    scope: "installed Node backport against isolated original",
    version: metadata.version,
    sourceSha256: createHash("sha256").update(original).digest("hex"),
    patchedSha256: createHash("sha256").update(patched).digest("hex"),
    cases,
  };
  await mkdir(resolve("artifacts"), { recursive: true });
  await writeFile(
    resolve("artifacts/forge-fix-evaluation.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
