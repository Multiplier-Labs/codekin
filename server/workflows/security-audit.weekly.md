---
kind: security-audit.weekly
name: Security Audit
sessionPrefix: security
outputDir: security-reports
filenameSuffix: _security-audit.md
commitMessage: chore: security audit
---
You are performing an automated security audit. Please do the following:

1. Examine the project structure to understand the tech stack, entry points, and sensitive areas.

2. Scan for hardcoded secrets and credentials:
   - API keys, tokens, passwords, private keys embedded in source files
   - Secrets in config files, .env files committed to the repo
   - Base64-encoded credentials or obfuscated secrets
   - Run: `git log --all --oneline | head -20` and `git grep -rn "password\|secret\|api_key\|token\|private_key" -- "*.js" "*.ts" "*.py" "*.go" "*.env" "*.json" "*.yaml" "*.yml" 2>/dev/null | grep -v "node_modules\|.git\|test\|spec\|mock" | head -100`

3. Scan for insecure code patterns:
   - Injection vulnerabilities: SQL, command, LDAP, XPath injection
   - Unsafe use of eval(), exec(), subprocess with shell=True
   - Unsanitized user input passed to filesystem, database, or shell operations
   - Insecure deserialization (pickle.loads, YAML.load without SafeLoader, etc.)
   - Path traversal vulnerabilities (../../ in user-controlled paths)
   - Server-side request forgery (SSRF) risks

4. Check authentication and authorization:
   - Missing or bypassable auth checks
   - Weak session management (predictable tokens, no expiry)
   - Insecure direct object references (IDOR)
   - JWT misconfiguration (alg:none, weak secrets)

5. Check for common web security issues (if applicable):
   - XSS: unescaped user input in HTML output
   - CSRF: missing CSRF protection on state-changing endpoints
   - Insecure CORS configuration (wildcard origins with credentials)
   - Sensitive data in URLs, logs, or error messages

6. Check infrastructure and configuration:
   - Debug mode enabled in production config
   - Overly permissive file permissions or exposed admin endpoints
   - Insecure TLS/SSL configuration
   - Missing security headers (CSP, HSTS, X-Frame-Options)

7. Produce a structured Markdown report. Your entire response will be saved as the report file, so write valid Markdown only — no conversational preamble.

Report structure:
## Summary
(Overall risk rating: Critical/High/Medium/Low, key findings count by severity)

## Critical Findings
(Each finding: title, file:line, description, impact, remediation)

## High Findings
(Same format as Critical, top 10)

## Medium Findings
(Same format, top 10)

## Secrets & Credentials Exposure
(Any hardcoded or committed secrets found, with file paths — redact actual values)

## Recommendations
(Numbered list of 5–10 prioritised fixes, ordered by risk impact)

Important: Do NOT modify any source files. Do NOT output actual secret values — only describe their location and type.
