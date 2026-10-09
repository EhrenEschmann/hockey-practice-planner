# Data model

Everything in Firestore hangs off a **team**. A viewer's phone reads one small document to learn its teams, then one
small query per team for the list, then one header + one body for the practice on screen. Lists never carry drills.

```
teams/{teamId}                              { id, name, club, admins: [emails], updatedAt }     — teamDoc()
  members/{email}                           { role: 'coach' | 'family', name, playerIds }      — memberDocs(); the lookup the rules make
  players/{playerId}                        { name, contacts: [emails] }                       — playerDocs()
  practices/{pid}                           HEADER — practiceHeader(): id, teamId, kind ('game' or absent), team, opponent, date,
                                              time, coaches, open, sharedWith, sharedTeam, sentCoachesAt, sentTeamAt, deleted,
                                              updatedAt, owner, showPaths + stage (effective), drillNames, drillCount, minutes, hasVideo
    plan/body                               BODY — practiceBody(): { id, teamId, drills, updatedAt }   (the heavy part)
    clips/{drillId}                         a recorded intro / voice-over (one document, base64)
    videos/{drillId}_{at}_{i}               an uploaded video, in chunks
    views/{autoId}                          audit log: viewers append in their own name; the planner reads
    feedback/{uid}_{drillId|overall}        a coach's note; the author and the planner
  tasks/{week}                              { week: 'YYYY-MM-DD' (the Sunday), tasks: [...] }   — an official club team's week list
  stats/{playerId}_{week}                   { playerId, week, values, by }                      — a player's numbers for the week
  media/{id}                                a task's how-to audio / video chunks
practiceIndex/{pid}                         { teamId }  — lets an older link that named only the practice find its team
people/{email}                              { persona: 'coach' | 'team', teams: { [teamId]: { name, role, players?, club? } } }  — peopleDocs()
users/{uid}/meta/roster                     the planner's working document: teams, coaches, players, contacts, weekly tasks
users/{uid}/private/{name}                  the planner's secrets (e.g. 'anthropic': the encrypted Claude key)
requests/{uid}, attempts/{uid}              access requests, and sign-ins that got nowhere
```

## Who writes what

- The **planner** edits the roster (`users/{uid}/meta/roster`) and practices locally; `js/cloud.js` (`createSync`) writes
  the header whenever it changes and the body only when the drills change (fingerprints in `localStorage`
  `hpp.pubstate.v2`), and unfolds the roster into the team, member, player, task and people documents (`syncTeams`).
  A practice re-homed to another team moves with its clips, videos, views and feedback (`movePractice`).
- **Viewers** read `people/{email}` once (live), then `teams/{t}/practices` filtered by the stages their role may see
  (`where stage in ['coaches','team']` for a coach, `['team']` for a family), then the header + body of the open practice
  (`subscribePractice`). Hidden drills are filtered client-side with `publishedCopy()`; a viewer's query can only ever
  return headers the rules let them read.
- **Rules** (`firestore.rules`): `isPlanner()` is the hard-coded owner list; `isAdmin(t)` adds a team's `admins`;
  `isMember`/`isCoach` look up `members/{email}`; `viewable(t, header)` decides by stage, `open`, `sharedWith`,
  `sharedTeam`. Tested in `tests/rules.test.mjs` against the emulator (`npm run test:rules`).

## Routes

`/coach/{teamId}/{pid}`, `/team/{teamId}/{pid}`, `/coach/{teamId}` and `/team/{teamId}` (lists), `/coach` and `/team`
(team chooser when on several teams). A link with only a practice id (older links) is resolved through `practiceIndex`.

## Migration from the account-centric layout (October 2026)

The previous layout kept practices under `users/{uid}/practices`, a published copy per practice in `published/{pid}`,
access lists in `access/{pid}`, a per-person list in `inbox/{email}` and club data in `club/{teamId}`.
`scripts/migrate-to-teams.mjs` reads the live database, derives the team-layout documents with the same functions the app
uses, writes them, re-reads every one and checks it is identical, and checks that header + body rebuild each original
practice. Legacy documents are left in place (only the roster is rewritten, to add an *Unassigned* team for practices that
named none). Rehearse it in the emulator with `--import <backup>` first; `scripts/firestore-backup.mjs` makes the backup.
`scripts/cleanup-legacy.mjs` deletes the legacy collections, and only with `--yes-delete-legacy`.
