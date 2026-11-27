# OS

OS gives one person's AI agents the tools to act on what that person cares about, such as memory, secrets, and Google accounts. That person is the owner. Agents do the work through OS, and the owner signs in to see what they did and to approve what waits on them. Each installation serves one owner and runs as a Cloudflare Worker in the owner's Cloudflare account. So far, an installation has only owner sign-in; the modules come later.

## Install

You need:

- A Cloudflare account on the Workers Paid plan. On the Free plan, the first sign-ins after a cold start use more CPU time than the plan allows.
- A zone in that account for the hostname OS will use, and a Cloudflare Zero Trust organization.
- Node and Vite+ (`vp`).

The steps below use `os.example.com`. Replace it with your hostname.

### 1. Create two Cloudflare Access applications

In Zero Trust, create two self-hosted applications. Turn off Managed OAuth in both.

1. **OS**: the whole hostname `os.example.com`, with one Allow policy that includes only your email. Copy its Application Audience (AUD) tag for step 3.
2. **OS machine routes**: the same hostname with these four destinations, and one Bypass policy that includes everyone:
   - `os.example.com/mcp`
   - `os.example.com/oauth/token`
   - `os.example.com/.well-known/*`
   - `os.example.com/agent/*`

   Use exactly these destinations. Agents call these paths with their own credentials, so Access must let them through. Every path under `/api/` needs an Access sign-in, so a bypass that covers one of them locks you out of it.

### 2. Sign in to Cloudflare and build

```sh
vp install --frozen-lockfile
vp exec wrangler whoami
```

If `wrangler whoami` says you are not signed in, or does not list the account that will run OS, run `vp exec wrangler login`. If it lists more than one account, copy the Account ID of the one that will run OS and run `export CLOUDFLARE_ACCOUNT_ID=<that Account ID>`. Set it in every shell where you run the commands below or the commands in [Change the owner](#change-the-owner). Those commands read no input from the terminal, so Wrangler cannot ask you there to sign in or to choose an account.

Then build:

```sh
vp build
```

Run `vp build` before every deploy. `wrangler deploy` deploys what the build produced, and the build leaves out the local sign-in that `vp run dev` uses.

### 3. Deploy for the first time

Write the three secrets to a JSON file that only you can read, such as `secrets.json`. `ACCESS_ISSUER` is your Zero Trust team domain.

```json
{
  "OWNER_EMAIL": "you@example.com",
  "ACCESS_ISSUER": "https://<your-team>.cloudflareaccess.com",
  "ACCESS_AUDIENCE": "<the AUD tag from step 1>"
}
```

Then deploy, apply the database migrations, list the ones left, and delete the file:

```sh
vp exec wrangler deploy --domain os.example.com --secrets-file secrets.json < /dev/null
vp exec wrangler d1 migrations apply DB --remote < /dev/null
vp exec wrangler d1 migrations list DB --remote < /dev/null
rm secrets.json
```

`wrangler d1 migrations list` must report no migrations left to apply. Until the migrations run, `curl -i https://os.example.com/mcp` answers `503` with `{"error":"unavailable"}`, not the `404` that step 4 expects.

Later deploys need only `vp build` and `vp exec wrangler deploy < /dev/null`.

### 4. Check the installation

Without a session, run `curl -i https://os.example.com<path>` for each path below. A different answer usually means the destinations of the OS machine routes application are wrong.

| Path                                                                             | Expected answer                                                                    |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `/mcp`, `/mcp/x`, `/oauth/token`, `/oauth/token/x`, `/.well-known/x`, `/agent/x` | `404` with `{"error":"not_found"}`, from the Worker rather than an Access redirect |
| `/.well-known`, `/agent`, `/api/owner`                                           | A redirect to your Access team domain                                              |

Then run `curl -i -H 'Cf-Access-Jwt-Assertion: x' https://os.example.com/mcp`. It must also answer `404` with `{"error":"not_found"}`, because Cloudflare removes this header when a client sends it.

Last, open `https://os.example.com/api/owner` in a browser and sign in. It shows your email. This first sign-in records you as the owner.

## Change the owner

1. Change the Allow policy of the OS Access application to the new email.
2. Write `{"OWNER_EMAIL": "<new email>"}` to a secrets file, run `vp exec wrangler deploy --secrets-file secrets.json < /dev/null`, and delete the file. Deploy it to all traffic at once. An older version that still serves requests accepts the old owner.
3. Run `vp run owner:reset`.

Until the reset, the new owner and every agent get `503` with `{"error":"owner_locked"}`, and a session the previous owner still holds gets `403` with `{"error":"not_owner"}`. Deploying the old `OWNER_EMAIL` again unlocks the installation without a reset. The reset deletes everything that belonged to the previous owner, such as agent connections. The new owner's first sign-in records them as the owner.

## Run locally

Put `OWNER_EMAIL=owner@example.com` in `.dev.vars` and run `vp run dev`. Locally, OS signs in every visitor as that email, without Cloudflare Access, so it listens only on localhost. To open it from another device, bind it to one address that device can reach, such as a Tailscale IP: `vp run dev --host <ip>`. OS signs in anyone who reaches that address as the owner. `vp run owner:reset:local` resets the local owner.
