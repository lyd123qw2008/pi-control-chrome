# Security Policy

`pi-control-chrome` controls a user's existing Chrome or Edge profile and can access pages, downloads, clipboard data, dialogs, and browser debugging capabilities. Install and use it only from a source you trust.

## Reporting a vulnerability

Please do not publish credentials, Bridge tokens, browser profiles, or a working exploit in a public issue. Use a private GitHub security advisory for this repository when available. If private advisories are unavailable, contact the repository owner through GitHub before disclosing details publicly.

## Local security boundary

The Bridge binds to `127.0.0.1`. Its `GET /pair` bootstrap endpoint returns the bearer token to any process that can reach that loopback port so the unpacked extension can pair without a native host. This is an intentional trusted-local v1 design: any local process running as the same user, and any installed extension allowed to call the endpoint, must be treated as able to control the connected browser. Loopback is not a process-authentication boundary. Keep the Bridge port off network proxies and do not run untrusted local software alongside it.
