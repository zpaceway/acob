import { state } from "./state.js";
import type {
  Configuration,
  ProxyResult,
  ProxyScheme,
  ProxySetResult,
  ProxyUnsetResult,
} from "./types.js";

export interface ParsedProxy {
  scheme: ProxyScheme;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
}

export function parseProxyString(value: string): ParsedProxy {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      "Invalid proxy string: must be scheme://[user[:password]@]host:port",
    );
  }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase() as string;
  if (scheme !== "http" && scheme !== "https" && scheme !== "socks5") {
    throw new Error(
      "Invalid proxy string: scheme must be one of http, https, socks5",
    );
  }
  if (!parsed.hostname) {
    throw new Error("Invalid proxy string: host is required");
  }
  const port = parsed.port ? Number(parsed.port) : NaN;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid proxy string: port must be 1-65535");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("Invalid proxy string: query and fragment are not allowed");
  }
  if (parsed.pathname !== "" && parsed.pathname !== "/") {
    throw new Error("Invalid proxy string: path is not allowed");
  }
  const username = parsed.username ? decodeURIComponent(parsed.username) : null;
  const password = parsed.password ? decodeURIComponent(parsed.password) : null;
  if (parsed.username && (!username || username.length > 255)) {
    throw new Error("Invalid proxy string: invalid credentials");
  }
  if (password !== null && password.length > 255) {
    throw new Error("Invalid proxy string: invalid credentials");
  }
  return {
    scheme: scheme as ProxyScheme,
    host: parsed.hostname,
    port,
    username,
    password,
  };
}

function toSingleProxyScheme(
  scheme: ProxyScheme,
): "http" | "socks5" {
  // Chrome's proxy rules use "http" for both http/https CONNECT proxies.
  if (scheme === "https") {
    return "http";
  }
  if (scheme === "http") {
    return "http";
  }
  return "socks5";
}

export function runInProxyQueue<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  const previous = state.proxyQueue;
  const result = previous.then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  state.proxyQueue = tail;
  return result;
}

export async function executeProxySet(
  proxy: string,
  _configuration: Configuration,
): Promise<ProxySetResult> {
  if (state.reinstallScheduled) {
    throw new Error("Extension reinstall is in progress");
  }
  const parsed = parseProxyString(proxy);
  return runInProxyQueue(async () => {
    const configValue = {
      mode: "fixed_servers" as const,
      rules: {
        singleProxy: {
          scheme: toSingleProxyScheme(parsed.scheme),
          host: parsed.host,
          port: parsed.port,
        },
        bypassList: ["localhost", "127.0.0.1", "[::1]"],
      },
    };
    try {
      await chrome.proxy.settings.set({
        value: configValue,
        scope: "regular",
      });
    } catch (error) {
      throw new Error(
        `Could not set the proxy: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (parsed.username) {
      state.proxyCredentials = {
        username: parsed.username,
        password: parsed.password ?? "",
      };
    } else {
      state.proxyCredentials = null;
    }
    return {
      proxied: true as const,
      scheme: parsed.scheme,
      host: parsed.host,
      port: parsed.port,
      authenticated: parsed.username !== null,
    };
  });
}

export async function executeProxyUnset(
  _configuration: Configuration,
): Promise<ProxyUnsetResult> {
  if (state.reinstallScheduled) {
    throw new Error("Extension reinstall is in progress");
  }
  return runInProxyQueue(async () => {
    try {
      await chrome.proxy.settings.clear({ scope: "regular" });
    } catch (error) {
      throw new Error(
        `Could not clear the proxy: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    state.proxyCredentials = null;
    return { proxied: false as const };
  });
}

export async function executeProxy(
  payload: { method: "set"; proxy: string } | { method: "unset" },
  configuration: Configuration,
): Promise<ProxyResult> {
  if (payload.method === "set") {
    return executeProxySet(payload.proxy, configuration);
  }
  return executeProxyUnset(configuration);
}

// Top-level auth handler so the service worker wakes for proxy 407s.
// Credentials live only in worker memory and are never persisted.
if (
  typeof chrome !== "undefined" &&
  chrome.webRequest?.onAuthRequired?.addListener
) {
  try {
    chrome.webRequest.onAuthRequired.addListener(
      (details) => {
        if (details.isProxy !== true) {
          return {};
        }
        const credentials = state.proxyCredentials;
        if (credentials === null) {
          return {};
        }
        return {
          authCredentials: {
            username: credentials.username,
            password: credentials.password,
          },
        };
      },
      { urls: ["<all_urls>"] },
      ["asyncBlocking"],
    );
  } catch {
    // webRequest auth is unavailable in this context (e.g. unit tests).
  }
}
