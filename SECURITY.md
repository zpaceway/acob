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

Remove browser IDs, cookies, credentials, page content, screenshots, and other
sensitive data from reports unless they are essential to the finding. The
maintainers will investigate, coordinate remediation and disclosure with the
reporter, and credit reporters who want public attribution.

## Deployment Considerations

ACOB is a browser-control system with intentionally powerful access. The
extension uses Chromium's debugger API and host access for all URLs. The HTTP
API can enqueue JavaScript, input, navigation, and screenshot instructions.

The checked-in server configuration is for trusted local development. It has
no API authentication or TLS, uses a committed development secret, enables
Django debug mode, accepts every host, and exempts API POST routes from CSRF
protection. The Compose configuration publishes the API port on all host
interfaces.

- Bind the server to a trusted interface unless network access is explicitly
  secured by authentication and transport controls outside ACOB.
- Treat browser IDs as routing identifiers, not authentication secrets.
- Do not expose the development server directly to untrusted networks.
- Run the extension in a dedicated browser profile without unrelated accounts
  or sensitive sessions.
- Review scripts and automation clients before allowing them to enqueue work.
- Keep the server, extension, client, browser, and dependencies updated.

Operational hardening questions that do not disclose a vulnerability may be
opened as regular GitHub issues.
