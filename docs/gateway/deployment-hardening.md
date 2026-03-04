---
summary: "Operator hardening matrix for bind, auth, proxy, tailscale, and exposure choices"
read_when:
  - Deploying OpenClaw on VPS, Docker, or remote hosts
  - Deciding safe defaults for network exposure
title: "Deployment Hardening"
---

# Deployment hardening matrix

Use this page to pick a safe deployment shape before exposing any gateway
surface.

Related runbooks:

- [Gateway security](/gateway/security)
- [Remote access](/gateway/remote)
- [Docker](/install/docker)
- [Tailscale](/gateway/tailscale)

## Baseline defaults

Start here unless you have a concrete reason to relax controls:

```json5
{
  gateway: {
    bind: "loopback",
    auth: {
      mode: "token",
      token: "<long-random-token>",
    },
  },
}
```

## Deployment matrix

| Deployment shape       | Recommended bind                      | Auth baseline                | Exposure boundary                     | Required hardening                                                                        |
| ---------------------- | ------------------------------------- | ---------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------- |
| Local workstation only | `loopback`                            | `token` (or strong password) | No external network path              | Keep Control UI local, rotate token if shared terminal access exists                      |
| Remote via SSH tunnel  | `loopback`                            | `token` or password          | SSH tunnel endpoint only              | Do not open gateway port publicly; pass explicit `--token`/`--password` on remote tooling |
| Tailnet private access | `loopback`                            | `token` (or password)        | Tailnet identity boundary             | Prefer Tailscale Serve over LAN binds; keep `trustedProxies` strict                       |
| Public reverse proxy   | `loopback` behind proxy               | Password or token mandatory  | Proxy + TLS boundary                  | Set strict origin allowlists, strict proxy trust, no anonymous gateway auth               |
| Docker on VPS          | `loopback` (inside host routing plan) | `token` or password          | Host firewall + Docker network policy | Enforce `DOCKER-USER` rules, avoid wide host port exposure, audit compose/network mode    |

## Bind and auth decision table

| Choice                             | Safe default                                       | Risk if misused                                                               |
| ---------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------- |
| `gateway.bind`                     | `loopback`                                         | `lan`/`tailnet`/custom bind without auth opens control plane to network peers |
| `gateway.auth.mode`                | `token`                                            | `none` on non-loopback exposure is critical risk                              |
| `gateway.trustedProxies`           | explicit list only                                 | overly broad proxy trust enables spoofed client IP/origin behavior            |
| `gateway.controlUi.allowedOrigins` | explicit origins for non-loopback                  | missing origin constraints can expose browser control surface                 |
| `gateway.auth.allowTailscale`      | enabled only for trusted tailnet operator boundary | weak trust assumptions can bypass explicit token/password checks              |

## Common anti patterns

- Non-loopback bind with `gateway.auth.mode: "none"`.
- Public Tailscale Funnel without strict password auth.
- Treating `gateway.remote.token` as server auth configuration (it is client-side config only).
- Using wildcard/broad trusted proxy settings without an explicit reverse-proxy boundary.
- Enabling broad tool profiles before inbound DM/group policy is locked down.

## Operator checklist

1. Set bind + auth first (`loopback` + token/password).
2. Choose one exposure path (SSH tunnel, tailnet, or reverse proxy) and lock all others.
3. Run `openclaw security audit` after any network/auth change.
4. Re-run with `openclaw security audit --deep` on the deployed host.
5. For plugin-enabled deployments, run `openclaw plugins lint-policy` before promoting changes.
