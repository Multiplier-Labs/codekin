# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest  | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability in Codekin, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please use [GitHub Security Advisories](https://github.com/Multiplier-Labs/codekin/security/advisories/new) to report the issue privately. Include:

- A description of the vulnerability
- Steps to reproduce the issue
- The potential impact
- Any suggested fixes (optional)

## Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 1 week
- **Fix and disclosure**: We aim to resolve confirmed vulnerabilities within 30 days

## Security Considerations

Codekin spawns Claude Code CLI processes and exposes a WebSocket server. When deploying:

- Run behind a reverse proxy with authentication
- Restrict `CORS_ORIGIN` to trusted domains
- Never expose the WebSocket port directly to the internet without authentication
- Keep API keys in environment variables, never in code or config files

## Disclosure

Once a fix is available, we will:

1. Release a patched version
2. Publish a security advisory on GitHub
3. Credit the reporter (unless they prefer anonymity)
