import { test } from "node:test";
import assert from "node:assert/strict";
import { validateArtwork, validateManifest, sha256 } from "./app-brand-validation.mjs";

const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="white" d="M0 0h24v24H0z"/></svg>');
const record = () => ({
  slug: "example", provider: "Example", aliases: [], localAsset: "/brands/apps/example.svg", darkAsset: "/brands/apps/example.svg",
  themeMode: "same", darkVariantRequired: false, assetType: "svg", opticalFit: "standard",
  selection: { note: "Supplied artwork", opticalReview: "Pending" },
  provenance: Object.fromEntries(["light", "dark"].map((theme) => [theme, { sourceClass: "user-supplied", sourceFile: "example.svg", sourceUrl: "https://example.com/icon.svg", sha256: sha256(svg), acquiredAt: "2026-09-11" }])),
});
const check = (row, read = () => svg) => validateManifest({ schemaVersion: 1, providers: [row] }, read);

test("accepts authentic vector artwork, native gradients and actual PNG bytes", () => {
  assert.equal(check(record()), 1);
  validateArtwork(Buffer.from('<svg viewBox="0 0 24 24"><defs><linearGradient id="g"/></defs><path fill="url(#g)"/></svg>'), "gradient.svg");
  validateArtwork(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"), "native.png");
  assert.throws(() => validateArtwork(Buffer.from("89504e470d0a1a0a", "hex"), "truncated.png"), /PNG/);
  assert.throws(() => validateArtwork(svg, "fake.png"), /PNG/);
});
for (const payload of ['<script/>', '<foreignObject/>', '<image href="data:image/png;base64,abc"/>', '<path onload="x()"/>', '<use href="https://example.com/a.svg#x"/>', '<style>@import "x"</style>', '<path fill="url(https://example.com/x)"/>', '<animate attributeName="href"/>', '<style>@media(prefers-color-scheme:dark){}</style>', '<use href="&#35;x"/>']) {
  test(`rejects unsupported SVG features: ${payload}`, () => assert.throws(() => validateArtwork(Buffer.from(`<svg viewBox="0 0 24 24">${payload}</svg>`), "unsafe.svg"), /unsafe/));
}
test("rejects missing paths, incomplete theme pairs, hashes and provenance", () => {
  assert.throws(() => check(record(), () => { throw new Error("ENOENT"); }), /ENOENT/);
  const pair = record(); delete pair.darkAsset; assert.throws(() => check(pair), /theme pair/);
  const missing = record(); delete missing.provenance.light.sourceClass; assert.throws(() => check(missing), /provenance/);
  assert.throws(() => check(record(), () => Buffer.from("changed")), /hash mismatch/);
  const traversal = record(); traversal.localAsset = "/brands/apps/../x.svg"; traversal.darkAsset = traversal.localAsset; assert.throws(() => check(traversal), /asset path/);
});
test("rejects ambiguous aliases, permits shared art for separate identities", () => {
  const a = record(); const b = { ...record(), slug: "second", provider: "Second", aliases: ["Example"] };
  assert.throws(() => validateManifest({ schemaVersion: 1, providers: [a, b] }, () => svg), /ambiguous/);
  b.aliases = []; assert.equal(validateManifest({ schemaVersion: 1, providers: [a, b] }, () => svg), 2);
});
