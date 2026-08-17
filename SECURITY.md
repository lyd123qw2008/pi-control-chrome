# Security Policy

`pi-control-chrome` controls a user's existing Chrome or Edge profile and can access pages, downloads, clipboard data, dialogs, and browser debugging capabilities. Install and use it only from a source you trust.

## Reporting a vulnerability

Please do not publish credentials, Bridge tokens, browser profiles, or a working exploit in a public issue. Use a private GitHub security advisory for this repository when available. If private advisories are unavailable, contact the repository owner through GitHub before disclosing details publicly.

## Local security boundary

The Bridge binds to `127.0.0.1` and requires a local pairing token. Keep the token file private and do not expose the Bridge port through a proxy or public network interface.
