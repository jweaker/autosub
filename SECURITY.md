# Security

AutoSub is designed to be run by one person for their own household, reachable from the internet through a tunnel. These are the properties it tries to hold.

## Trust boundaries

- **The install token is the only authentication.** Every addon route is prefixed with `INSTALL_TOKEN` and compared in constant time; anything else returns 404. Anyone with the manifest URL has full use of the addon, so treat it as a password. Generate it with `openssl rand -hex 32`.
- **Video never passes through AutoSub.** The play route records the release and issues a 302 to the debrid URL. Only addon metadata and finished subtitles cross the tunnel.
- **Torrent-only results are dropped.** A stream without an HTTP(S) URL is never handed to a client, so AutoSub cannot cause a client to start a torrent.
- **Provider responses are treated as untrusted input.** Download URLs are pinned to the provider's documented origin and path prefixes, archives are size-limited and filtered by extension before extraction, and header values taken from an upstream are stripped of CRLF before reaching FFmpeg.
- **Timestamps never reach the language model.** Gemini receives cue ids and text under a fixed schema; the validated timing is reapplied locally.

## Handling secrets

- `.env` is gitignored; keep it `chmod 600`. `.env.example` contains placeholders only.
- Nothing in the logs prints an API key, the install token, or the configured upstream URL.
- State files under `data/` are written with mode `0600`.
- The startup banner warns when the token is unset or short, when `PUBLIC_URL` is not HTTPS, and when the upstream is missing.

## Hardening notes

- Bind the container to loopback (the provided compose file does) and let the tunnel be the only ingress.
- The container runs as a non-root user, installs dependencies with install scripts disabled, and ships no shell tooling beyond what FFmpeg and Python need.
- A per-address rate limit (`RATE_LIMIT_PER_MINUTE`, default 180/min) applies to every route.
- Child processes run with explicit timeouts and output ceilings; nothing is executed through a shell.

## Reporting

Open a GitHub issue for non-sensitive problems. For anything exploitable, use GitHub's private vulnerability reporting on this repository rather than a public issue.
