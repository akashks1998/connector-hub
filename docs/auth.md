# Authentication

A plugin picks one auth preset. Credential values are CEL over `secrets` and
`config`; `secrets.*` comes from the host's `secrets` port and is visible
nowhere else in the plugin.

```yaml
config:
  api_key: { secret: true }
```

## Presets

```yaml
auth: { type: none }

auth:
  type: api_key
  in: header            # or query
  name: X-Api-Key
  value: secrets.api_key

auth:
  type: bearer
  token: secrets.token

auth:
  type: basic
  username: config.user
  password: secrets.password

auth:
  type: oauth2_client_credentials
  token_url: /oauth/token          # relative to the first host, or absolute
  client_id: secrets.client_id
  client_secret: secrets.client_secret
  scope: read write                # optional
  style: form                      # form (credentials in body) or basic (Authorization header)
  default_ttl_s: 3600              # used when the response has no expires_in
```

## OAuth client credentials

- The token is cached through the host's `tokens` port, per binding, and
  reused until 60 seconds before it expires.
- If the provider answers 401 or 403 with a cached token, the engine drops the
  token, fetches a new one and retries once. A second rejection fails as
  `reauth`.
- A 400, 401 or 403 from the token endpoint fails as `reauth`.
- `token_url` must be on one of the plugin's `hosts`.

OAuth authorization-code flows (where a user signs in) belong to the host: run
the flow in your application, store the access token as a secret, and use the
`bearer` preset. Refresh-token support is on the roadmap.
