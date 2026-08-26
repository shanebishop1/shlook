# shlook

Private-by-default Cloudflare hosting for agent-created HTML, static sites, and
images. The project is under active development and is not deployed yet.

## Development

Requirements: Node.js 24 and pnpm 11.17.0.

```bash
pnpm install --frozen-lockfile
pnpm fmt
pnpm run ci
```

Oxlint owns linting and Oxfmt owns formatting. `pnpm run ci` runs lint, format
checking, strict TypeScript checking, tests, and a Wrangler dry-run build.

## Architecture

One Cloudflare Worker owns the API and artifact-serving routes. One D1 database
stores metadata and lifecycle state; one private R2 bucket stores bytes. The E1
runtime supports private asset creation, file upload, manifest finalization,
inspection, archive listing, latest/direct views, and exact-one-asset deletion.
Uploads remain hidden until every manifest file is durable and the asset enters
the `live` state.

Current API routes:

- `POST /api/assets` creates an uploading asset.
- `PUT /api/assets/:id/files/:path` uploads one regular file.
- `POST /api/assets/:id/finalize` validates `{ entrypoint, files }` and publishes.
- `GET /api/assets?offset=<n>` and `GET /api/assets/:id` page and inspect assets.
- `GET /latest` and `GET /assets/:id/` serve live content.
- `DELETE /api/assets/:id` deletes one asset and its scoped objects.

Planned host boundaries:

- `show.shane-bishop.com`: owner UI and agent API behind Cloudflare Access.
- `private.show.shane-bishop.com`: owner-authenticated private artifacts.
- `share.shane-bishop.com`: explicitly public or secret-link artifacts.

See `docs/project.md` for operational boundaries and gate status.

## License

MIT, Copyright Shane Bishop. See `LICENSE`.
