# Federated social module plan

Status: initial implementation on `feature/social-feed`; public pilot deployment
and compatibility with other ActivityPub software remain to be verified. See
[operation and validation](../SOCIAL.md). Development is in
[primitiveType/openGym](https://github.com/primitiveType/openGym).

Add an optional Hevy-style feed where people on independent openGym servers can
follow one another, approve friends, browse profiles and workout history, and
exchange likes and comments. Support both public and friends-only visibility.
Approved friends see the current workout logs, including subsequent edits; users
do not need to publish a separate snapshot of each session.

## Profiles and workout access

Social participation requires explicit opt-in by the account owner and must also
be enabled by the server operator. The existing Everything module preset must
never create a social identity or grant access to training history by itself.

At onboarding, explain that approving a friend grants read-only access to the
profile and existing workout history, and that future workouts will be visible
to friends by default. An account that has not opted in remains private.
Friends means approved followers for the first release; approval is directional
and does not require a matching follow in the other direction.

| Audience | Profile and workout behavior |
| --- | --- |
| Only me | The workout is excluded from shared history and the feed. |
| Friends | Approved followers can browse current and historical workouts. |
| Public | Anyone can read the explicitly public profile fields and workouts. |

The profile exposes a chosen display name, bio, avatar when media support lands,
and workout-derived statistics for the viewer's permitted audience. Public stats
must not reveal counts or totals from friends-only or private workouts. Keep
body measurements, weigh-ins, heart rate, location, recovery codes, credentials,
and private notes outside the shared profile and workout representation.

An owner can mark individual workouts private or public. Approving a new friend
grants access to past friends-visible workouts as well as future ones. A removed
friend loses further access on the home server and stops receiving updates.
Browsing another person's log never permits changing their training state.

## Feed behavior

Start with a chronological Following feed, profiles with paginated workout
history, workout detail, follow requests, likes, comments, and notifications.
Provide mute, block, and report controls in the first federated release.

A feed entry references a stable workout object. Its displayed title, exercises,
sets, reps, weights, duration, volume, and records reflect the latest authorized
version. Editing a saved workout updates its existing feed entry without creating
a second entry or moving it to the top. Deleting or making it private removes it
from shared views and starts remote deletion. Historical imports become browsable
without generating a burst of new-workout notifications.

Comments and reactions inherit the workout's audience and cannot broaden it.
The initial implementation is text and workout data only. Photos and videos wait
until authorized media delivery is covered by the same access tests.

Turning the module off hides the feed, pauses sharing of new workouts, and cancels
queued new-workout publications and notifications. Previously shared logs remain
available until the owner chooses to revoke sharing or delete them. Edits,
deletions, and access removals for already shared logs continue to propagate.
Keep removal controls available while the module is off; disabling a module is
not remote deletion.

## Federation protocol

Use ActivityPub for the first implementation. It defines server-to-server
delivery, selected audiences, follow approval, updates, and deletion. Use standard
actors, Follow/Accept/Reject, Create/Update/Delete, Like/Undo, and Note replies.
Add WebFinger lookup for handles such as `@arthur@social.example.com`.

Represent a workout with a readable summary plus a versioned structured
attachment. Other openGym instances render exercise details; compatible general
ActivityPub software can display the summary. Define units, stable exercise
identifiers with name fallbacks, schema versions, and pagination before building
the feed. Do not redistribute the licensed exercise animations through federation.

Bluesky uses AT Protocol. Its established repositories are public, while Atproto
Spaces for permissioned data remains a draft. Do not make the first friends-only
release depend on it. A later explicit Bluesky bridge can publish selected public
workouts, with its own account-linking and deletion behavior. ActivityPub and AT
Protocol do not interoperate automatically.

Evaluate Fedify in a two-server prototype for discovery, signatures, authorized
fetch, and durable delivery. Keep it in the social service so the existing
dependency-light training API does not become a federation server. Confirm the
library's current Node compatibility and SQLite support before selecting versions.

## Service boundary and live data

Keep the phone and training application on their existing Tailscale HTTPS origin.
Add an isolated `opengym-social` service with its own SQLite database, signing
keys, durable delivery queue, and storage directory. It has no mount of private
training data, session secrets, or the Docker socket.

The existing API authenticates the owner and builds an allowlisted shared view of
their profile and workout logs. It sends authorized changes to the social service
over an authenticated internal API, and proxies the owner's feed requests. Use
an idempotent reconciliation path and a durable change queue so a social-service
outage cannot block or lose a saved workout. Bind each social actor to its local
account on the server; never trust a client-supplied owner identifier.

The private training log remains authoritative. The social service holds a
versioned projection of the shareable fields, not an independently edited or
frozen post. Remote servers can cache that projection and must process updates
and deletions. On reconnect, reconcile missed changes before resuming ordinary
delivery. Cross-server views are eventually consistent, not instantaneous.

Audience changes are authorization changes, not just presentation changes. When
access narrows, cancel obsolete deliveries, invalidate local caches, and send
removal to former recipients. Do not rely only on hiding a card in the frontend.

## Routing and authorization

Public federation needs a stable domain and publicly reachable HTTPS endpoints.
Expose the social service through a dedicated reverse proxy, or a small VPS
connected to the home server through Tailscale. Choose the public social domain
before inviting users because actor and object identities depend on it. Changing
the training app's hostname or passkey origin is unnecessary.

Friends-only resources require verified remote identity and explicit audience
authorization on object reads, history, feeds, replies, search, counts, previews,
and future media routes. Signed requests alone are not authorization. Verify
actor ownership of updates and deletions; reject forged or replayed activities
and deduplicate legitimate retries. Test authorized-fetch compatibility between
our own servers before promising support for other software.

Rate-limit delivery and discovery, bound payload size and traversal, sanitize
remote text, and prevent outbound federation requests from reaching loopback,
private networks, cloud metadata, or the tailnet, including through redirects
and DNS rebinding. Keep moderation and connection rules outside public views.

Friends-only federation trusts the recipients and their server operators. It is
not end-to-end encryption and cannot prevent copying. Removing access or deleting
a post cannot guarantee erasure on a remote server. A workout that was once
public may remain in third-party archives even after its audience changes.

## Implementation scope

| Area | Required work |
| --- | --- |
| Modules | Add Social to the registry, copy, locales, search, routes, and notifications; require participation consent independently of presets. |
| Workout and profile views | Add audience controls, editable social profile, feed, remote history, follow requests, likes, comments, and moderation. |
| API and sync | Document authenticated social routes in OpenAPI; derive current shared views and durable changes from accepted state writes; preserve stable workout IDs across edits and imports. |
| Social service | Actors, access rules, projections, federation handlers, revision reconciliation, SQLite migrations, and durable delivery. |
| Account lifecycle | Export owned social data and relationships; revoke sharing and delete the actor when requested; do not copy remote logs into a user's private training history. |
| Operations | Compose configuration, public routing, health checks, pinned builds, backups, restore, and rollback instructions. |

Reuse the current module and state-write integration points. Keep shared history
out of the client's private training-state document and its ordinary sync merge.
Do not rewrite openGym's existing JSON persistence to build the social service.

## Reproducible deployment and backups

Pin the fork commit, lockfiles, build inputs, and published container digests.
Record the source revision and schema version with each build. Keep signing keys,
runtime data, OAuth credentials, and deployment `.env` files out of GitHub.

Store social state under `$CONFIG_ROOT/appdata/opengym-social`. Extend the media
stack's daily openGym backup to include this directory and take a consistent copy
of both services. Include actor keys, relationships, audiences, projections,
comments, moderation, revision cursors, deletion records, and pending deliveries.
Use the existing Google Drive upload and retention process.

Restore with outbound federation paused. Verify the domain and keys, reconcile
private training state with shared projections, and review queued deliveries
before resuming. Test that a restore does not duplicate posts, replay old
notifications, or unintentionally republish deleted/private logs. Changes made
after a backup are still subject to the backup's recovery window.

## Delivery milestones

1. Define the shared profile/workout schema, stable IDs, audience rules, and
   revocation behavior. Confirm the design against existing account and sync code.
2. Build two disposable social services and test follows, approval, public reads,
   friends-only current/history reads, updates, private transitions, deletion,
   retries, offline recovery, and unauthorized access. Include a third stranger
   account and local-only users who never enabled Social.
3. Connect opt-in openGym accounts, profile/history browsing, and workout changes.
   Build the mobile feed, likes, comments, notifications, and moderation controls.
4. Test module-off behavior, imports, account export/deletion, public routing,
   isolated backup/restore, migrations, and rollback. Pilot with approved servers
   before opening federation more broadly.

Defer direct messages, rankings, recommendations, video, and the Bluesky bridge.
Production deployment follows the two-server authorization and recovery checks.

## Fork workflow

Local checkout: `/run/media/arthur/Workspace/openGym`.
`origin` is `primitiveType/openGym`; `upstream` is `DuarteSantos8/openGym`.
Keep `main` aligned with upstream and put this work on `feature/social-feed`.
The initial planning base is `8fb98b16861a2728652302a7e6e30c50548493a0`.
The existing media-server deployment remains pinned to v1.4.4 until a separate
deployment is requested and verified.

With a clean checkout, bring upstream changes into the feature branch with:

```sh
git fetch upstream --tags
git switch main
git merge --ff-only upstream/main
git push origin main
git switch feature/social-feed
git merge main
git push origin feature/social-feed
```

This is a manual sync workflow. It preserves feature commits without rewriting
published history. Review conflicts and run relevant checks before pushing
implementation changes; do not force-update a diverged `main`.

## References

- [openGym module conventions](../MODULES.md)
- [openGym architecture](../ARCHITECTURE.md)
- [Hevy social feed](https://www.hevyapp.com/features/content-feed/)
- [ActivityPub specification](https://www.w3.org/TR/activitypub/)
- [Fedify access control](https://fedify.dev/manual/access-control)
- [AT Protocol public repositories](https://atproto.com/specs/repository)
- [Atproto Spaces draft](https://github.com/bluesky-social/proposals/blob/main/0016-permissioned-data/README.md)
