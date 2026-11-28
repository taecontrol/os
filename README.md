# OS

OS is a Cloudflare Worker that one person, the owner, installs in their own Cloudflare account. Its goal is to give the owner's AI agents tools to act on what the owner cares about, such as memory, secrets, and Google accounts, and to show the owner what those agents did. The owner signs in through Cloudflare Access and can manage agent connections and grants through the Core HTTP API.

## Install

You need:

- A Cloudflare account on the [Workers Paid plan](https://developers.cloudflare.com/workers/platform/pricing/). On the Free plan, the first sign-ins after a cold start use more CPU time than the plan allows.
- A domain [added to that account](https://developers.cloudflare.com/fundamentals/manage-domains/add-site/). OS runs on a hostname in it. The steps below use `os.example.com`; replace it with your hostname.
- A [Zero Trust organization](https://developers.cloudflare.com/cloudflare-one/setup/) in that account, with a [login method](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/) that verifies your email, such as one-time PIN.
- Git, Node 26, and [Vite+](https://viteplus.dev/guide/) (`vp`).

Get the code, and run every command below from its directory:

```sh
git clone https://github.com/taecontrol/os.git
cd os
```

### 1. Create two Cloudflare Access applications

In Zero Trust, [create two self-hosted applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/). Leave [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/) turned off in both.

1. **OS**: the whole hostname `os.example.com`, with one Allow policy that includes only your email. Copy its [Application Audience (AUD) tag](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/#get-your-aud-tag) for step 3.

   In the Cloudflare dashboard, go to **Zero Trust → Access controls → Applications** and edit **OS**. Under **Advanced settings → Cookie settings**, set **SameSite Attribute** to **Lax** or **Strict** and save. This keeps browsers from sending the `CF_Authorization` session cookie with cross-site `POST`, `PUT`, or `DELETE` requests. [Cloudflare Access cookie settings](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/#cookie-settings)

2. **OS machine routes**: the same hostname with these four destinations, and one Bypass policy that includes everyone:
   - `os.example.com/mcp`
   - `os.example.com/oauth/token`
   - `os.example.com/.well-known/*`
   - `os.example.com/agent/*`

   Agents will connect on these paths with their own credentials, so Access must let requests through. OS requires an Access sign-in on every path under `/api/`, so a bypass that covers one of them locks you out of it.

### 2. Sign in to Cloudflare and build

```sh
vp install --frozen-lockfile
vp exec wrangler whoami
```

If `wrangler whoami` says you are not signed in, or does not list the account that will run OS, run `vp exec wrangler login`. If it lists more than one account, copy the Account ID of the one that will run OS and run `export CLOUDFLARE_ACCOUNT_ID=<that Account ID>`. Set it in every new shell before you run Wrangler or `vp run owner:reset`. The deploy and migration commands below read no input from the terminal, so Wrangler cannot ask you there to sign in or to choose an account.

Build before every deploy. `wrangler deploy` deploys what `vp build` produced, and the build leaves out the local sign-in that `vp run dev` uses.

```sh
vp build
```

### 3. Deploy for the first time

Create a secrets file that only you can read. Git does not ignore it, so never commit it.

```sh
(umask 077 && touch secrets.json)
```

Write the three secrets into it:

```json
{
  "OWNER_EMAIL": "you@example.com",
  "ACCESS_ISSUER": "https://<your-team>.cloudflareaccess.com",
  "ACCESS_AUDIENCE": "<the AUD tag from step 1>"
}
```

- `OWNER_EMAIL` is the email in the Allow policy from step 1. If the two differ, Access lets you in and OS answers `403`.
- `ACCESS_ISSUER` is your Zero Trust team domain. Your team name is in Zero Trust under Settings.
- `ACCESS_AUDIENCE` is the AUD tag from step 1.

The first deploy creates the D1 database and the KV namespace that holds OAuth grants. `DB` is the name `wrangler.jsonc` gives the database, so type it as shown.

```sh
vp exec wrangler deploy --domain os.example.com --secrets-file secrets.json < /dev/null
vp exec wrangler d1 migrations apply DB --remote < /dev/null
vp exec wrangler d1 migrations list DB --remote < /dev/null
rm secrets.json
```

`wrangler d1 migrations list` must report no migrations left to apply.

### 4. Check the installation

Without a session, run `curl -i https://os.example.com<path>` for each path below.

| Path                                                 | Expected answer                                                        |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `/mcp`, `/mcp/x`                                     | `401` with `{"error":"invalid_token"}` and a `WWW-Authenticate` header |
| `/oauth/token`                                       | `401` with `{"error":"invalid_client"}`                                |
| `/.well-known/oauth-protected-resource/mcp`          | `200` with `{"resource":"https://os.example.com/mcp", …}`              |
| `/oauth/token/x`, `/.well-known/x`, `/agent/x`       | `404` with `{"error":"not_found"}` from the Worker                     |
| `/authorize`, `/.well-known`, `/agent`, `/api/owner` | A redirect to your Access team domain                                  |

If an answer differs:

- A redirect where the table expects an answer from the Worker means the destinations of the OS machine routes application are wrong.
- `503` with `{"error":"setup_incomplete"}` means a secret is missing or invalid. The `missing` field names it.
- `503` with `{"error":"unavailable"}` usually means the migrations have not run.

Then run `curl -i -H 'Cf-Access-Jwt-Assertion: x' https://os.example.com/mcp`. It must also answer `401` with `{"error":"invalid_token"}` because Cloudflare removes this header when a client sends it.

Last, open `https://os.example.com/api/owner` in a browser and sign in. It shows your email. This first sign-in records you as the owner.

## Update OS

From the updated checkout, build OS and apply pending migrations to the existing D1 database.

```sh
vp build
vp exec wrangler d1 migrations apply DB --remote < /dev/null
vp exec wrangler d1 migrations list DB --remote < /dev/null
```

Before you deploy, check **SameSite Attribute** for the **OS** Access application using [the cookie instructions in step 1](#1-create-two-cloudflare-access-applications). Set it to **Lax** or **Strict** and save if needed.

If the setting was **None**, edit **OS** again after saving and select **Revoke existing tokens** to end all active OS sessions, including any whose `CF_Authorization` cookie still has `SameSite=None`. [Cloudflare Access session revocation](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/#per-application)

Deploy the Worker once you finish the Access steps and Wrangler reports no migrations left to apply.

```sh
vp exec wrangler deploy < /dev/null
```

## Change the owner

1. Change the Allow policy of the OS Access application to the new email.
2. Create a secrets file as in step 3 that holds only `{"OWNER_EMAIL": "<new email>"}`. Run `vp exec wrangler deploy --secrets-file secrets.json < /dev/null`, then delete the file. This deploy sends the new version to all traffic. Do not roll it out gradually, because an older version that still serves requests accepts the old owner.
3. Run `vp run owner:reset`.

Until the reset, the new owner and machine requests get `503` with `{"error":"owner_locked"}`. A session the previous owner still holds gets `403` with `{"error":"not_owner"}`. To go back without a reset, restore both the Allow policy and the old `OWNER_EMAIL`. The reset clears the recorded owner and deletes their connections, grants, and audit entries. The new owner's first sign-in records them.

## Run locally

Put `OWNER_EMAIL=owner@example.com` in `.dev.vars`, run `vp run dev`, and open `/api/owner` at the address it prints. It shows that email. Locally, OS signs in every visitor as that email, without Cloudflare Access, so it listens only on localhost. To open it from another device, bind it to one address that device can reach, such as a Tailscale IP: `vp run dev --host <ip>`. OS signs in anyone who reaches that address as the owner. `vp run owner:reset:local` resets the local owner.
