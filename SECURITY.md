# Security Policy

## Supported Versions

Security fixes are applied to the current `master` branch and the latest
release. Older releases are not maintained with backported security fixes.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| `master` | Yes |
| Older releases | No |

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
