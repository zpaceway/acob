import assert from "node:assert/strict";
import test from "node:test";

type AuthDetails = { isProxy?: boolean };
type AuthResult = Record<string, unknown>;

let authListener: ((details: AuthDetails) => AuthResult) | null = null;
const setCalls: Array<{ value: unknown; scope: unknown }> = [];
const clearCalls: Array<unknown> = [];
let setImpl: (args: { value: unknown; scope: unknown }) => Promise<void> =
  async () => undefined;
let clearImpl: (args: unknown) => Promise<void> = async () => undefined;

Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: {
    debugger: {
      onDetach: {
        addListener: () => undefined,
        removeListener: () => undefined,
      },
    },
    proxy: {
      settings: {
        set: async (args: { value: unknown; scope: unknown }) => {
          setCalls.push(args);
          return setImpl(args);
        },
        clear: async (args: unknown) => {
          clearCalls.push(args);
          return clearImpl(args);
        },
      },
    },
    webRequest: {
      onAuthRequired: {
        addListener: (listener: (details: AuthDetails) => AuthResult) => {
          authListener = listener;
        },
      },
    },
  },
});

const { executeProxy, executeProxySet, executeProxyUnset, runInProxyQueue } =
  await import("../src/proxy.js");
const { ACOBSettings } = await import("../src/settings.js");
const { state } = await import("../src/state.js");

const configuration = ACOBSettings.normalizeConfiguration();

function resetProxyState(): void {
  state.reinstallScheduled = false;
  state.proxyCredentials = null;
  state.proxyQueue = Promise.resolve();
  setCalls.length = 0;
  clearCalls.length = 0;
  setImpl = async () => undefined;
  clearImpl = async () => undefined;
}

function getAuthListener(): (details: AuthDetails) => AuthResult {
  assert.ok(authListener !== null, "auth listener must be registered");
  return authListener;
}

function singleProxyScheme(): string {
  const value = setCalls[0]?.value as {
    rules?: { singleProxy?: { scheme?: string } };
  };
  assert.ok(value?.rules?.singleProxy?.scheme);
  return value.rules.singleProxy.scheme as string;
}

test("executeProxySet maps https/http to http and socks5 stays socks5", async () => {
  resetProxyState();
  await executeProxySet("https://proxy.example:8443", configuration);
  assert.equal(singleProxyScheme(), "http");

  resetProxyState();
  await executeProxySet("http://127.0.0.1:8080", configuration);
  assert.equal(singleProxyScheme(), "http");

  resetProxyState();
  await executeProxySet("socks5://127.0.0.1:1080", configuration);
  assert.equal(singleProxyScheme(), "socks5");
});

test("executeProxySet tracks auth credentials and the authenticated flag", async () => {
  resetProxyState();
  const authed = await executeProxySet(
    "http://user:pass@127.0.0.1:8080",
    configuration,
  );
  assert.equal(authed.authenticated, true);
  assert.deepEqual(state.proxyCredentials, {
    username: "user",
    password: "pass",
  });

  resetProxyState();
  const anon = await executeProxySet("http://127.0.0.1:8080", configuration);
  assert.equal(anon.authenticated, false);
  assert.equal(state.proxyCredentials, null);

  resetProxyState();
  const userOnly = await executeProxySet(
    "socks5://onlyuser@127.0.0.1:1080",
    configuration,
  );
  assert.equal(userOnly.authenticated, true);
  assert.deepEqual(state.proxyCredentials, {
    username: "onlyuser",
    password: "",
  });
});

test("executeProxySet refuses while reinstall is scheduled", async () => {
  resetProxyState();
  state.reinstallScheduled = true;
  try {
    await assert.rejects(
      executeProxySet("http://127.0.0.1:8080", configuration),
      /reinstall is in progress/,
    );
    assert.equal(setCalls.length, 0);
  } finally {
    state.reinstallScheduled = false;
  }
});

test("executeProxySet maps chrome failures with Error and non-Error", async () => {
  resetProxyState();
  setImpl = async () => {
    throw new Error("denied");
  };
  await assert.rejects(
    executeProxySet("http://127.0.0.1:8080", configuration),
    /Could not set the proxy: denied/,
  );

  resetProxyState();
  setImpl = async () => {
    throw "string-failure";
  };
  await assert.rejects(
    executeProxySet("http://127.0.0.1:8080", configuration),
    /Could not set the proxy: string-failure/,
  );
});

test("executeProxyUnset clears credentials and maps failures", async () => {
  resetProxyState();
  state.proxyCredentials = { username: "u", password: "p" };
  const result = await executeProxyUnset(configuration);
  assert.deepEqual(result, { proxied: false });
  assert.equal(state.proxyCredentials, null);
  assert.equal(clearCalls.length, 1);

  resetProxyState();
  state.reinstallScheduled = true;
  try {
    await assert.rejects(
      executeProxyUnset(configuration),
      /reinstall is in progress/,
    );
    assert.equal(clearCalls.length, 0);
  } finally {
    state.reinstallScheduled = false;
  }

  resetProxyState();
  clearImpl = async () => {
    throw new Error("clear-denied");
  };
  await assert.rejects(
    executeProxyUnset(configuration),
    /Could not clear the proxy: clear-denied/,
  );

  resetProxyState();
  clearImpl = async () => {
    throw 42;
  };
  await assert.rejects(
    executeProxyUnset(configuration),
    /Could not clear the proxy: 42/,
  );
});

test("executeProxy dispatches set and unset", async () => {
  resetProxyState();
  const setResult = await executeProxy(
    { method: "set", proxy: "http://127.0.0.1:8080" },
    configuration,
  );
  assert.equal(setResult.proxied, true);

  resetProxyState();
  const unsetResult = await executeProxy({ method: "unset" }, configuration);
  assert.deepEqual(unsetResult, { proxied: false });
});

test("runInProxyQueue serializes operations in order", async () => {
  resetProxyState();
  const order: string[] = [];
  const first = runInProxyQueue(async () => {
    order.push("first-start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push("first-end");
    return 1;
  });
  const second = runInProxyQueue(async () => {
    order.push("second");
    return 2;
  });
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ["first-start", "first-end", "second"]);
});

test("runInProxyQueue survives a rejected operation", async () => {
  resetProxyState();
  await assert.rejects(
    runInProxyQueue(async () => {
      throw new Error("queue boom");
    }),
    /queue boom/,
  );
  const after = await runInProxyQueue(async () => "recovered");
  assert.equal(after, "recovered");
});

test("auth listener ignores non-proxy challenges", () => {
  resetProxyState();
  state.proxyCredentials = { username: "u", password: "p" };
  assert.deepEqual(getAuthListener()({ isProxy: false }), {});
  assert.deepEqual(getAuthListener()({}), {});
});

test("auth listener returns empty without credentials", () => {
  resetProxyState();
  state.proxyCredentials = null;
  assert.deepEqual(getAuthListener()({ isProxy: true }), {});
});

test("auth listener supplies stored proxy credentials", () => {
  resetProxyState();
  state.proxyCredentials = { username: "alice", password: "s3cret" };
  try {
    assert.deepEqual(getAuthListener()({ isProxy: true }), {
      authCredentials: { username: "alice", password: "s3cret" },
    });
  } finally {
    state.proxyCredentials = null;
  }
});
