# Security Policy

## Supported Versions

Security fixes are applied to the current `master` branch. The server,
extension, and Python client are versioned independently; when a component is
released, only its latest release is supported unless a release notice states
otherwise. Older versions do not receive backported fixes.

| Version | Supported |
| --- | --- |
| `master` | Yes |
| Latest release of each component | Yes |
| Older component releases | No |

## Reporting a Vulnerability

Do not report suspected vulnerabilities in a public issue, discussion, or pull
request. Use GitHub's private
[security advisory form](https://github.com/zpaceway/acob/security/advisories/new)
instead.

Include the following when available:

- The affected component and version or commit.
- Reproduction steps or a minimal proof of concept.
- The expected and observed impact.
- Relevant configuration and environment details.
- Any suggested mitigation.

Remove stack URLs, cookies, credentials, page content, screenshots, and other
sensitive data from reports unless they are essential to the finding. The
maintainers will investigate, coordinate remediation and disclosure with the
reporter, and credit reporters who want public attribution.

## Deployment Considerations

ACOB is a browser-control system with intentionally powerful access. The
extension uses Chromium's debugger API and host access for all URLs. The HTTP
API can enqueue JavaScript, input, navigation, and screenshot instructions.

The shipped architecture is local-only. It has no API authentication, executor
identity, or claim leases. A stack has one global queue with per-browser `bid`
targeting, but `bid` is a routing hint rather than an authorization boundary,
so untargeted instructions remain claimable by any extension polling it. It must
not be exposed to a network or treated as an enterprise control plane without
adapting the architecture.

Root `make install PORT=<port> NAME=<name>` creates a named, port-specific
Compose project, network, server volume, and managed Chromium profile. `NAME` is
required, and the resulting context is `acob-<port>-<name>`. The proxy publishes
the selected API/MCP port on localhost (`58346` by default). Optional
passwordless noVNC is disabled by default and, when enabled, is served under
`/vnc` on that same loopback proxy. Separate trusted browsers with separate stack instances and
proxy ports; a second extension on the same endpoint is not an isolation
boundary.

The native development server has no API authentication or TLS, uses a
committed development secret, enables Django debug mode, accepts every host,
and exempts API POST routes from CSRF protection. Native ports `58347` and
`58348` are for local development only.

- Keep installed proxy ports and native development services on loopback or an
  equivalently trusted local boundary.
- Enable passwordless VNC only temporarily on a trusted local machine.
- Do not expose the development server directly to untrusted networks.
- Enterprise or network use requires authentication and authorization, secure
  transport, explicit executor identity and affinity, claim leases, scoped
  policy, auditing, and operational hardening; a reverse proxy alone is not
  sufficient.
- Run the extension in a dedicated browser profile without unrelated accounts
  or sensitive sessions.
- Review scripts and automation clients before allowing them to enqueue work.
- Keep the server, extension, client, browser, and dependencies updated.

Operational hardening questions that do not disclose a vulnerability may be
opened as regular GitHub issues.
