export function parseExplicitPort(value: string, parsed: URL): number {
  const portText = parsed.port || /:(\d+)(?:[/?#]|$)/.exec(value)?.[1];
  return portText ? Number(portText) : NaN;
}
