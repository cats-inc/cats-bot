# Security Guidelines

> Internal security policies and best practices for development.

## Overview

This document outlines security practices for developers and AI agents working on this project.

## Sensitive Data Handling

### Never Commit

- API keys and secrets
- Passwords and credentials
- Private keys and certificates
- Personal identifiable information (PII)

### Environment Variables

```bash
# CORRECT: Use .env (not committed)
DATABASE_URL=postgresql://user:password@localhost/db

# Provide template in .env.example (committed)
DATABASE_URL=postgresql://user:password@localhost/db
```

### Pre-commit Check

Before committing, verify:
- [ ] No secrets in code
- [ ] No hardcoded credentials
- [ ] `.env` is in `.gitignore`

## Code Security

### Input Validation

- Validate all user inputs
- Sanitize data before database queries
- Use parameterized queries (prevent SQL injection)

### Authentication & Authorization

- (Add project-specific auth guidelines)

### Dependencies

- Keep dependencies updated
- Review security advisories
- Use lockfiles (`package-lock.json`, `poetry.lock`)

## Agent-Specific Rules

AI agents MUST NOT:

- Execute destructive commands (`rm -rf /`, `DROP DATABASE`, etc.)
- Access files outside project directory without explicit permission
- Commit secrets or credentials
- Disable security features

AI agents SHOULD:

- Flag potential security issues when reviewing code
- Suggest security improvements
- Follow principle of least privilege

## Incident Response

If a security issue is discovered:

1. Do not commit the vulnerability
2. Report to project maintainer
3. Document in `docs/decisions/` after resolution

## Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [CWE Top 25](https://cwe.mitre.org/top25/)

---

*Last updated: YYYY-MM-DD*
