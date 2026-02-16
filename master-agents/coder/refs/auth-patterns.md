# Auth Implementation Patterns

## Strategy Selection
| Strategy | When | Tradeoff |
|----------|------|----------|
| Session-based | Traditional web, server rendering | Stateful, simple, doesn't scale horizontally without session store |
| JWT | APIs, SPAs, microservices | Stateless, scales well, can't revoke without blacklist |
| OAuth2/OIDC | Social login, delegated auth | Complex but standard, handles third-party well |
| API Keys | Service-to-service, public APIs | Simple, no user context, rotate regularly |

## JWT Best Practices
- Short-lived access tokens (15 min)
- Long-lived refresh tokens (7-30 days, stored securely)
- Sign with RS256 (asymmetric) for microservices, HS256 for single service
- Include: `sub`, `exp`, `iat`, `iss`. Never include: passwords, PII, secrets
- Validate: signature, expiration, issuer, audience

## RBAC Implementation
```
User → has Roles → Roles have Permissions → Check permission before action
```
- Permissions are granular: `users:read`, `users:write`, `users:delete`
- Roles are collections: `admin = [users:*, settings:*]`, `viewer = [users:read]`
- Check at middleware/decorator level, not inline

## Security Checklist
- [ ] Passwords hashed with bcrypt/argon2 (NEVER MD5/SHA)
- [ ] HTTPS enforced for all auth endpoints
- [ ] CSRF protection for cookie-based auth
- [ ] Rate limiting on login/register endpoints
- [ ] Account lockout after N failed attempts
- [ ] Secrets in env vars, never in code
- [ ] Token rotation on privilege escalation
- [ ] Logout invalidates session/token server-side
