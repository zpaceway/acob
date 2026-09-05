import assert from "node:assert/strict";
import test from "node:test";

import { parseProxyString } from "../src/proxy.js";

test("parses http/https/socks5 proxy strings", () => {
  assert.deepEqual(parseProxyString("http://127.0.0.1:8080"), {
    scheme: "http",
    host: "127.0.0.1",
    port: 8080,
    username: null,
    password: null,
  });
  assert.deepEqual(parseProxyString("https://proxy.example:8443"), {
    scheme: "https",
    host: "proxy.example",
    port: 8443,
    username: null,
    password: null,
  });
  assert.deepEqual(parseProxyString("socks5://127.0.0.1:1080"), {
    scheme: "socks5",
    host: "127.0.0.1",
    port: 1080,
    username: null,
    password: null,
  });
});

test("parses proxy auth credentials", () => {
  assert.deepEqual(parseProxyString("http://user:pass@127.0.0.1:8080"), {
    scheme: "http",
    host: "127.0.0.1",
    port: 8080,
    username: "user",
    password: "pass",
  });
  assert.deepEqual(parseProxyString("socks5://user@127.0.0.1:1080"), {
    scheme: "socks5",
    host: "127.0.0.1",
    port: 1080,
    username: "user",
    password: null,
  });
});

test("rejects invalid proxy strings", () => {
  for (const proxy of [
    "",
    "not-a-url",
    "ftp://127.0.0.1:21",
    "http://127.0.0.1",
    "http://127.0.0.1:0",
    "http://127.0.0.1:99999",
    "http://127.0.0.1:8080/path",
    "http://127.0.0.1:8080?x=1",
    "http://127.0.0.1:8080#frag",
    "http://:8080",
  ]) {
    assert.throws(() => parseProxyString(proxy), /Invalid proxy string/);
  }
});
