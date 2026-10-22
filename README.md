# Document download service

This minimal service exposes GET /download?name=guide.txt to untrusted remote
users through a reverse proxy. It requires Node.js and no external packages.
Run it with node server.mjs.

Only files under public/ are intended to be downloadable. Files under private/
are internal service data and must never be returned by the public endpoint.
The caller controls the name query parameter. The deployment boundary treats
HTTP clients as untrusted; there is no authentication requirement for public
documents.

All files in this branch are synthetic test data. Run only in an isolated
test environment; this branch has no deployment configuration.
