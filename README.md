# OS

OS gives one owner's AI agents the tools to act on what the owner cares about, such as memory, secrets, and Google accounts. Agents do the work through OS. The owner signs in to see what they did and approve what waits on them. Each installation serves one owner and runs in that owner's Cloudflare account.

## Install

You need a Cloudflare account with a zone for the hostname OS will use, a Cloudflare Zero Trust organization, Node, and Vite+ (`vp`). The steps below use `os.example.com`; use your own hostname.

### 1. Create two Cloudflare Access applications

In Zero Trust, create two self-hosted applications, both with Managed OAuth turned off:

1. **OS**: the whole hostname `os.example.com`, with one Allow policy that includes only your email. Copy its Application Audience (AUD) tag.
2. **OS machine routes**: the same hostname with these destinations, and one Bypass policy that includes everyone:
   - `os.example.com/mcp`
   - `os.example.com/oauth/token`
   - `os.example.com/.well-known/*`
   - `os.example.com/agent/*`

   Keep exactly this list. Core refuses an Access assertion on these paths and requires one everywhere else under `/api/`.

### 2. Build

```sh
vp install --frozen-lockfile
vp build
```

Always deploy what `vp build` produced. The build is what leaves the local development owner out of the Worker.

### 3. Deploy for the first time

Write the three secrets to a JSON file that only you can read:

```json
{
  "OWNER_EMAIL": "you@example.com",
  "ACCESS_ISSUER": "https://<your-team>.cloudflareaccess.com",
  "ACCESS_AUDIENCE": "<the AUD tag from step 1>"
}
```

Then deploy, apply the database migrations, and delete the file:

```sh
vp exec wrangler deploy --domain os.example.com --secrets-file secrets.json < /dev/null
vp exec wrangler d1 migrations apply DB --remote < /dev/null
vp exec wrangler d1 migrations list DB --remote < /dev/null
rm secrets.json
```

The last command must report no migrations left to apply. Until the migrations run, Core answers `503`. Later deploys need only `vp build` and `vp exec wrangler deploy < /dev/null`.

### 4. Check the installation

Without a session:

- `curl -i https://os.example.com/mcp` answers `404` with `{"error":"not_found"}`, from the Worker rather than an Access redirect.
- `curl -i https://os.example.com/api/owner` redirects to your Access team domain.
- `curl -i -H 'Cf-Access-Jwt-Assertion: x' https://os.example.com/mcp` answers `400` with `{"error":"access_assertion_rejected"}`.

Then open `https://os.example.com/api/owner` in a browser, sign in, and check that it shows your email. That first sign-in pins you as the owner.

## Change the owner

1. Change the Allow policy of the OS Access application to the new email.
2. Write `{"OWNER_EMAIL": "<new email>"}` to a secrets file, deploy it in one step with `vp exec wrangler deploy --secrets-file secrets.json < /dev/null`, and delete the file. Never roll this change out gradually: an older version would keep accepting the old owner.
3. Run `vp run owner:reset`.

Until the reset, OS refuses everyone with `owner_locked`. Restoring the old `OWNER_EMAIL` unlocks it without a reset. The reset deletes everything that belonged to the previous owner, such as agent connections, and the new owner pins themselves at their first sign-in.

## Run locally

Put `OWNER_EMAIL=owner@example.com` in `.dev.vars` and run `vp run dev`. Locally, OS signs in as that email without Cloudflare Access. `vp run owner:reset:local` resets the local owner.
