import assert from "node:assert/strict";
import {
  constants,
  createHash,
  generateKeyPairSync,
  privateEncrypt,
  verify,
} from "node:crypto";

// Encode the small, fixed regression structures independently of forge's parser.
const der = (tag, value) =>
  Buffer.concat([Buffer.from([tag, value.length]), value]);
const sequence = (...children) => der(0x30, Buffer.concat(children));
const algorithms = {
  sha1: "2b0e03021a",
  sha256: "608648016503040201",
  sha384: "608648016503040202",
  sha512: "608648016503040203",
};

export function checkForgeSignatures(forge) {
  // Ephemeral test material only; never persisted or included in reports.
  const keys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 65537,
  });
  const publicPem = keys.publicKey.export({ type: "spki", format: "pem" });
  const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" });
  const verifier = forge.pki.publicKeyFromPem(publicPem.toString());
  const message = Buffer.from("hikaro official forge regression fixture");
  const sign = (bytes) =>
    privateEncrypt(
      { key: keys.privateKey, padding: constants.RSA_PKCS1_PADDING },
      bytes,
    );
  const rejects = (hash, digest, encoded) => {
    const signature = sign(encoded);
    assert.throws(
      () =>
        verifier.verify(
          digest.toString("binary"),
          signature.toString("binary"),
        ),
      /DigestInfo/,
    );
    assert.equal(verify(hash, message, keys.publicKey, signature), false);
  };
  const cases = [];
  for (const [hash, oid] of Object.entries(algorithms)) {
    const digest = createHash(hash).update(message).digest();
    for (const parameters of [false, true]) {
      const algorithm = [der(0x06, Buffer.from(oid, "hex"))];
      if (parameters) algorithm.push(der(0x05, Buffer.alloc(0)));
      const valid = sequence(sequence(...algorithm), der(0x04, digest));
      const signature = sign(valid);
      assert.equal(
        verifier.verify(
          digest.toString("binary"),
          signature.toString("binary"),
        ),
        true,
      );
      // OpenSSL requires explicit NULL here; forge also supports its omission.
      if (parameters)
        assert.equal(verify(hash, message, keys.publicKey, signature), true);
      rejects(
        hash,
        digest,
        sequence(
          sequence(
            ...algorithm,
            der(0x04, Buffer.from("unexpected extra field")),
          ),
          der(0x04, digest),
        ),
      );
      cases.push({
        hash,
        parameters,
        validAccepted: true,
        malformedRejected: true,
        nativeRejectedMalformed: true,
      });
    }
  }
  const digest = createHash("sha256").update(message).digest();
  const oid = der(0x06, Buffer.from(algorithms.sha256, "hex"));
  const valid = sequence(
    sequence(oid, der(0x05, Buffer.alloc(0))),
    der(0x04, digest),
  );
  // These were accepted by 1.4.0 even with the old element-count backport.
  const malformed = {
    nullWithContent: sequence(
      sequence(oid, der(0x05, Buffer.from([0]))),
      der(0x04, digest),
    ),
    nonMinimalLength: Buffer.concat([
      Buffer.from([0x30, 0x81, valid[1]]),
      valid.subarray(2),
    ]),
    nonCanonicalOid: sequence(
      sequence(
        der(
          0x06,
          Buffer.concat([
            Buffer.from([0x80]),
            Buffer.from(algorithms.sha256, "hex"),
          ]),
        ),
        der(0x05, Buffer.alloc(0)),
      ),
      der(0x04, digest),
    ),
  };
  for (const encoded of Object.values(malformed))
    rejects("sha256", digest, encoded);
  // 1.4.2 restores the Buffer input accepted before the 1.4.1 PEM ReDoS fix.
  assert.deepEqual(
    forge.pem.decode(Buffer.from(publicPem)),
    forge.pem.decode(publicPem.toString()),
  );
  assert.equal(
    forge.pki.publicKeyFromPem(Buffer.from(publicPem)).n.toString(),
    verifier.n.toString(),
  );
  assert.equal(
    forge.pki.privateKeyFromPem(Buffer.from(privatePem)).n.toString(),
    verifier.n.toString(),
  );
  return {
    cases,
    canonicalEncodingRejected: Object.keys(malformed),
    pemBufferAccepted: true,
  };
}
