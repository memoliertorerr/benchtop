/**
 * Test certificates made at run time (BT104): a CA and a server certificate signed by it, so no
 * private key is ever committed. Keys from node:crypto (RSA 2048); the certificates are
 * X.509 v3 DER built here by hand (just the fields TLS clients check: names, validity, the key,
 * basicConstraints, keyUsage, subjectAltName) and signed with sha256WithRSAEncryption.
 */

import { createPrivateKey, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

function der(tag: number, content: Uint8Array): Uint8Array {
  const n = content.length;
  const length = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : n < 0x10000 ? [0x82, n >> 8, n & 0xff] : [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff];
  return concat([Uint8Array.of(tag, ...length), content]);
}

const seq = (...items: Uint8Array[]): Uint8Array => der(0x30, concat(items));
const set = (...items: Uint8Array[]): Uint8Array => der(0x31, concat(items));
const nul = (): Uint8Array => der(0x05, new Uint8Array(0));
const bool = (v: boolean): Uint8Array => der(0x01, Uint8Array.of(v ? 0xff : 0));
const utf8 = (s: string): Uint8Array => der(0x0c, new TextEncoder().encode(s));
const octets = (b: Uint8Array): Uint8Array => der(0x04, b);
const bits = (b: Uint8Array, unused = 0): Uint8Array => der(0x03, concat([Uint8Array.of(unused), b]));
const explicit = (n: number, content: Uint8Array): Uint8Array => der(0xa0 + n, content);

function int(value: bigint): Uint8Array {
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  const raw = Uint8Array.from(Buffer.from(hex, 'hex'));
  const bytes = raw[0] & 0x80 ? concat([Uint8Array.of(0), raw]) : raw;
  return der(0x02, bytes);
}

function oid(dotted: string): Uint8Array {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [40 * a + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >>> 7; v > 0; v >>>= 7) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return der(0x06, Uint8Array.from(out));
}

function utcTime(date: Date): Uint8Array {
  const p = (n: number): string => String(n).padStart(2, '0');
  const s = `${p(date.getUTCFullYear() % 100)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  return der(0x17, new TextEncoder().encode(s));
}

const name = (cn: string): Uint8Array => seq(set(seq(oid('2.5.4.3'), utf8(cn))));
const SHA256_RSA = (): Uint8Array => seq(oid('1.2.840.113549.1.1.11'), nul());
const extension = (id: string, critical: boolean, value: Uint8Array): Uint8Array => (critical ? seq(oid(id), bool(true), octets(value)) : seq(oid(id), octets(value)));

export interface TestCert {
  /** PEM of the certificate. */
  cert: string;
  /** PEM (PKCS#8) of its private key. */
  key: string;
  keyObject: KeyObject;
}

let serial = 1000n;

function certificate(subject: string, issuer: string, publicDer: Uint8Array, signer: KeyObject, ca: boolean, dns: string | null): string {
  const now = Date.now();
  const extensions = [
    extension('2.5.29.19', true, ca ? seq(bool(true)) : seq()),
    extension('2.5.29.15', true, ca ? bits(Uint8Array.of(0x06), 1) : bits(Uint8Array.of(0xa0), 5)),
  ];
  if (dns !== null) extensions.push(extension('2.5.29.17', false, seq(der(0x82, new TextEncoder().encode(dns)))));
  const tbs = seq(
    explicit(0, int(2n)),
    int(serial++),
    SHA256_RSA(),
    name(issuer),
    seq(utcTime(new Date(now - 86_400_000)), utcTime(new Date(now + 30 * 86_400_000))),
    name(subject),
    publicDer,
    explicit(3, seq(...extensions)),
  );
  const signature = sign('sha256', tbs, signer);
  const body = Buffer.from(seq(tbs, SHA256_RSA(), bits(signature))).toString('base64');
  return `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)?.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/** A self-signed CA ("Benchtop Test CA") and a key to sign with. */
export function makeCa(cn = 'Benchtop Test CA'): TestCert {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const cert = certificate(cn, cn, publicKey.export({ type: 'spki', format: 'der' }), privateKey, true, null);
  return { cert, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, keyObject: privateKey };
}

/** A server certificate for `dns`, signed by `ca`. */
export function makeServerCert(ca: TestCert, caName: string, dns: string): TestCert {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const cert = certificate(dns, caName, publicKey.export({ type: 'spki', format: 'der' }), createPrivateKey(ca.key), false, dns);
  return { cert, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, keyObject: privateKey };
}
