import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyAddress,
  contentLimit,
  createPublicUrlValidator,
  selectPublicAddress,
  validatePublicHttpUrl,
  validatePublicHttpUrlDetailed,
} from "./safe-http.ts";

test("classifyAddress rejects local, special-use, and mapped addresses", () => {
  const rejected: Array<[string, string]> = [
    ["127.0.0.1", "local"],
    ["10.0.0.1", "private"],
    ["100.64.0.1", "cgnat"],
    ["169.254.0.1", "link-local"],
    ["192.0.2.1", "reserved"],
    ["224.0.0.1", "multicast"],
    ["::ffff:8.8.8.8", "ipv4-mapped"],
    ["fc00::1", "private"],
    ["fe80::1", "link-local"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "reserved"],
  ];

  for (const [address, expected] of rejected) {
    assert.equal(classifyAddress(address), expected, address);
  }
  assert.equal(classifyAddress("8.8.8.8"), "public");
  assert.equal(classifyAddress("2001:4860:4860::8888"), "public");
  assert.equal(classifyAddress("168.63.129.16"), "reserved");
});

test("validatePublicHttpUrl canonicalizes safe literals and rejects userinfo", async () => {
  assert.equal(
    await validatePublicHttpUrl("https://8.8.8.8/path#fragment"),
    "https://8.8.8.8/path",
  );
  await assert.rejects(
    validatePublicHttpUrl("https://user:pass@example.com/"),
    /userinfo/i,
  );
  await assert.rejects(validatePublicHttpUrl("http://127.0.0.1/"), /not public/i);
});

test("createPublicUrlValidator accepts a per-call cache", async () => {
  const validator = createPublicUrlValidator(new Map());
  assert.equal(await validator("http://8.8.8.8/"), "http://8.8.8.8/");
});

test("public URL validation honors an already-aborted signal", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled");
  controller.abort(reason);

  await assert.rejects(
    validatePublicHttpUrlDetailed(
      "https://example.com/",
      new Map(),
      controller.signal,
    ),
    (error) => error === reason,
  );
});

test("selectPublicAddress rejects mixed DNS answers and pins the first public answer", () => {
  assert.throws(
    () =>
      selectPublicAddress("mixed.example", [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    /non-public/i,
  );
  assert.throws(
    () =>
      selectPublicAddress("mixed-v6.example", [
        { address: "2001:4860:4860::8888", family: 6 },
        { address: "fe80::1", family: 6 },
      ]),
    /non-public/i,
  );
  assert.throws(() => selectPublicAddress("empty.example", []), /did not resolve/i);
  assert.deepEqual(
    selectPublicAddress("public.example", [
      { address: "93.184.216.34", family: 4 },
      { address: "2001:4860:4860::8888", family: 6 },
    ]),
    { address: "93.184.216.34", family: 4 },
  );
});

test("body limits cannot be raised above the content policy", () => {
  assert.equal(contentLimit("text/plain", 50 * 1024 * 1024), 5 * 1024 * 1024);
  assert.equal(contentLimit("application/octet-stream", Number.MAX_SAFE_INTEGER), 50 * 1024 * 1024);
});
