# Federated Social

Social is an opt-in experimental module for sharing current workout logs between
openGym servers. It includes a Following feed, profiles and workout history,
approved followers, public/friends/private audiences, likes, comments,
notifications, reports, mute and block, account export, and social-account deletion.

Approving a follower grants access to existing and future friends-visible workout
logs. Saved workout edits update the same object; deleting a workout or making it
private sends removal requests. Social never exposes body measurements, weigh-ins,
heart rate, location, private workout notes, or private media. Public display name
and bio are a separate choice. Individual workouts start friends-only after consent.

The module switch pauses new sharing. Existing shared logs still receive edits and
deletions. Settings → Social remains available for managing or removing them.
Deleting a social account preserves the private training log. Social participation
cannot currently be reactivated on the same training account after deletion.

Friends-only access trusts the recipients and their server operators; it is not
end-to-end encryption. Public or previously delivered content can be retained by
others. Changing visibility cannot recall those copies.

## Run the fork

Use the API, web, and social service built from the same fork revision. An upstream
prebuilt API/web pair does not include Social. The feature branch is
`feature/social-feed` in `primitiveType/openGym`.

```sh
cp .env.example .env  # only on a new checkout; preserve an existing configuration
node social/setup.mjs
```

Set `SOCIAL_ORIGIN=https://social.example.com` in `.env`, using a permanent public
domain you control. Keep the training application's existing `RP_ID` and `ORIGIN`.
The social service needs its own publicly reachable HTTPS endpoint; Tailscale
Serve alone is private to your tailnet. The social domain is recorded in its
database, and changing it later is refused to protect identity and relationships.

`social/setup.mjs` creates `social-data/` and a private `social-secret` file without
printing its contents or replacing an existing secret. The host owner of these
files must match the social container's `PUID`/`PGID` (defaults 1000). Never commit
either file/directory, or a deployment `.env`, to GitHub.

```sh
VCS_REF=$(git rev-parse HEAD) docker compose -f docker-compose.yml -f docker-compose.social.yml up -d --build
```

The social service publishes only on `127.0.0.1:3100`. The existing API authenticates
users and proxies their social actions over an internal API. The social container
has no mount of the private training directory, session secret, media, or Docker
socket. Its signing keys and shared workout projection live in `social-data/`.

## Public proxy and federation policy

For Caddy on the same host, substitute the chosen domain:

```caddyfile
social.example.com {
    @federation path /.well-known/webfinger /users/* /objects/*
    handle @federation {
        reverse_proxy 127.0.0.1:3100
    }
    handle {
        respond 404
    }
}
```

Public traffic must never be forwarded to `/internal`, or to the private openGym
API. When the public proxy runs on a VPS, connect it to the service over a narrowly
permitted Tailscale route rather than publishing the training app. Supply the
original request path and method; the service uses its configured canonical origin.

Optional social-service environment settings in the Compose overlay:

| Setting | Behavior |
| --- | --- |
| `SOCIAL_ALLOWED_DOMAINS` | Comma-separated remote hostnames permitted to federate. Empty permits any nonblocked public host; use an allowlist for the initial pilot. |
| `SOCIAL_BLOCKED_DOMAINS` | Comma-separated remote hostnames refused regardless of the allowlist. |
| `SOCIAL_PAUSED=1` | Suspend outbound delivery, particularly during restore. |

Restart the service after changing policy. A user's Block control applies to that
user's interactions; server-wide policy belongs to the operator. Public objects
remain publicly readable, so a domain block is not a guarantee against scraping.

Federation uses Fedify's verified HTTP signatures, a five-minute signature window,
and private-address protection for discovery/delivery, including redirects and
DNS rebinding. The production entry point cannot enable private-address test mode.
Requests have bounded bodies, connection timeouts, per-address limits, and per-user
action limits. Unknown or inaccessible objects are never exposed through the
private app's history, feed, or interaction endpoints.

## Use Social

After deployment, open Settings → Social. Choose a handle and explicitly consent
to sharing history before creating the profile. Use Manage social profile to find
someone by `@name@domain` or their actor URL, send a follow request, and approve
incoming requests. Follow approval is directional: each person approves access
to their own logs.

The feed shows each workout’s audience, duration, sets, volume, and an exercise
preview. Expand Exercises for set details, or Comments to read and reply. The
gear button opens Manage social profile, including Connections.

Use Your workouts and expand Who can see this workout? to choose Only me,
Friends, or Public for each workout. A friend's
profile opens their current authorized history. Historic imports are browsable
without generating a burst of notifications. New training changes reconcile with
the social service every ten seconds; open feed screens refresh every thirty
seconds and have a manual Refresh button. A social-service outage does not prevent
saving a workout.

Public workout notes have a readable ActivityPub summary plus a versioned
`application/vnd.opengym.social+json` source. Federation, history, and interactions
are tested between this fork's servers. General Mastodon/other-client compatibility
is not certified, and arbitrary foreign posts are not imported into the workout
feed. Cross-server views are eventually consistent. The training server remains
authoritative; restoring older training state can also restore older shared data.

## Back up and restore

Back up `data/`, `social-data/`, `social-secret`, deployment configuration, and the
matching source revision/image references together. Stop both the API and social
service before copying their directories so the SQLite database, WAL files,
relationships, audience settings, and delivery queue are consistent. Resume both
services after the copy; compression and off-host upload can happen afterward.

For the media-stack checkout, the optional `compose.social.yml` and
`scripts/setup-opengym-social.sh` use `OPENGYM_SOCIAL_*` settings, persist data under
`$CONFIG_ROOT/appdata/opengym-social`, and mount the shared secret from
`$CONFIG_ROOT/secrets/opengym-social`. When enabled, the daily openGym backup copies
both services and this secret into the same archive; the existing Google Drive
upload also covers it. The overlay includes an isolated Caddy proxy with automatic
HTTPS on the configured LAN address's TCP ports 80 and 443. The router must forward
those same ports to that reserved address. Only federation paths are proxied;
the training app and `/internal` stay private. See the
[media-stack deployment notes](https://github.com/primitiveType/media-stack#opengym-backups-and-google-drive-copies)
for the current host and recovery details.

Restore to an isolated directory using the same social domain, secret, and matching
images. Set `SOCIAL_PAUSED=1`, reconcile the restored training data, and review
queued deliveries before resuming. Never start a second active copy of the same
identity. An older database cannot be opened with a schema it does not understand;
roll back code and data together. Backups retain their normal recovery window.

## Validation and current limits

```sh
cd social && npm ci --ignore-scripts && npm test
cd ../api && npm ci --omit=optional && npm test
cd ../frontend && npm ci && npm test && npm run build
```

The federation tests start independent HTTP servers with disposable accounts and
real signatures. They cover approval, historical access, edits, privacy changes,
multiple recipients on one server, interactions, revocation, deletion, forged
requests, production network guards, and isolated restore with delivery paused.

The current store targets small deployments and filters collections in memory;
add indexed queries before operating a large public instance. Photo/video sharing,
direct messages, rankings, recommendations, and a Bluesky bridge remain deferred.
New social copy uses English fallbacks in the non-English locale packs pending
reviewed translations.
