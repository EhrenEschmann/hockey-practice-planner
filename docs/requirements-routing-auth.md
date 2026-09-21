# Routing & authorization — requirements

Status: **built 2026-09-21** (open questions settled as proposed — see §10) · Decisions marked ✅ were made by Ehren.

Where it lives: the redirect matrix and who-gets-what are pure functions in [js/access.js](../js/access.js); the guarantees are [firestore.rules](../firestore.rules); tests are `npm test` (`tests/access.test.mjs` — the matrix, `tests/routing.test.mjs` — §11 in a real browser, `tests/rules.test.mjs` — §8 against the Firestore emulator).

## 1. Goal

One planner (Ehren) builds practices. A finished practice goes to the **coaches** for feedback, then to the
**team** (players' families). Each audience has its own URL space, sees only what it is entitled to, and a
person who lands in the wrong place is moved to the right one instead of hitting a dead end — or, if they have
no access at all, can ask for it.

## 2. Personas

| Persona | Who | Decided by |
|---|---|---|
| **Planner** | Ehren | The planner email list (`OWNER_EMAILS` in the app, `isPlanner()` in the Firestore rules). The only persona that can create or change anything. |
| **Coach** | Assistant coaches | ✅ The 👥 Team roster: a roster coach's email. |
| **Team** | Parents, grandparents, players | ✅ The 👥 Team roster: a player's family-contact email. |
| **Unknown** | Anyone else with a Google account | Not the planner and not on the roster. |
| **Anonymous** | Not signed in | — |

- R2.1 Persona is derived from the signed-in Google email, compared case-insensitively.
- R2.2 Precedence when an email qualifies twice: Planner > Coach > Team (a coach who is also a parent is a coach).
- R2.3 The roster is the single source of truth. Adding a person to the roster once gives them access to every
  practice later released to their persona; removing them revokes it — including the offline copy on their
  device the next time it is online.
- R2.4 A practice may still carry **extra emails** per audience (a guest coach, a one-off skater) on top of the roster.
- R2.5 Persona is per team: a coach of the U9s is not thereby a coach of another team on the roster.

## 3. Practice lifecycle

A practice has an explicit **stage**, changed only by the planner, only forwards or backwards one step at a time:

| Stage | Planner | Coach | Team |
|---|---|---|---|
| `draft` | edit | no access | no access |
| `coaches` — out for feedback | edit, read feedback | view + give feedback | no access |
| `team` — released | edit, read feedback | view + give feedback | view |

- R3.1 "Send to coaches" and "Release to team" are explicit buttons in the editor; filling in an email list alone releases nothing.
- R3.2 Pulling a practice back a stage removes that audience's access immediately (and their offline copies on next contact).
- R3.3 The editor shows each practice's stage, and when it was sent to each audience.
- R3.4 Edits made after release reach viewers live, as today.

## 4. Routes

Path-based URLs replace today's `#view=` / `#team=` fragments (fragments get mangled or dropped by some mail
and chat apps; paths do not).

| URL | Purpose | Who may stay on it |
|---|---|---|
| `/` | Never renders an app screen. Redirects by persona (R5). | nobody |
| `/editor` , `/editor/<practiceId>/<drillId>` | The practice creator | Planner |
| `/coach` | ✅ List of the practices released to this coach | Coach, Planner (preview) |
| `/coach/<practiceId>` | Coach view of one practice, with feedback | Coach, Planner (preview) |
| `/team` | ✅ List of the practices released to this person's team | Team, Coach, Planner (preview) |
| `/team/<practiceId>` | Team view of one practice | Team, Coach, Planner (preview) |
| `/request-access` | Request-access screen (R7); remembers the URL that was asked for | Unknown |

- R4.1 The editor code and UI are never loaded on any route but `/editor` (already true for share links today).
- R4.2 Practice lists (`/coach`, `/team`) show team, date, start time and stage-appropriate practices only,
  upcoming first, then past; one tap opens the practice. A bookmark or home-screen icon of `/coach` or `/team`
  therefore works all season.
- R4.3 Old links keep working: `#view=<owner>/<id>` → `/coach/<id>`, `#team=<owner>/<id>` → `/team/<id>`, including percent-encoded forms.
- R4.4 URLs carry no owner id — there is one planner account per deployment.
- R4.5 Every route works offline for a practice that device has opened before (today's rink-mode guarantee), and keeps the pull-to-reload, account / sign-out and rink-mode behaviour.
- R4.6 Unknown paths redirect to `/`.

## 5. Redirect matrix

Evaluated after sign-in state is known; while it is being determined the page shows only "Checking your sign-in…".

| Persona ↓ / lands on → | `/` | `/editor…` | `/coach…` | `/team…` |
|---|---|---|---|---|
| **Anonymous** | sign-in screen, then re-evaluate | sign-in, then re-evaluate | sign-in, then re-evaluate | sign-in, then re-evaluate |
| **Planner** | → `/editor` | stay | stay (preview as coach) | stay (preview as team) |
| **Coach** | → `/coach` | → `/coach` | stay | stay |
| **Team** | → `/team` | → `/team` | ✅ → the matching `/team…` URL (`/coach/<id>` → `/team/<id>`) | stay |
| **Unknown** | → `/request-access` | → `/request-access` | → `/request-access` | → `/request-access` |

- R5.1 Redirects preserve the practice id (`/coach/abc` → `/team/abc`), and replace the history entry so Back does not bounce.
- R5.2 The sign-in screen always offers Google's account chooser; every signed-in screen offers "Sign out / use a different account" (shipped 2026-09-21).
- R5.3 After sign-in the person continues to the URL they originally opened, subject to this matrix.
- R5.4 A known persona opening a practice they cannot see *yet* (team member, practice still at `coaches`; coach, practice still `draft`; or a practice that does not exist) gets **"This practice isn't available yet"** with a link to their list — not the request-access screen, which is for people with no standing at all. No information about the practice (name, date) is revealed.

## 6. What each view shows

✅ The coach view and the team view are **the same page**. The only differences are about feedback:

| | Planner (editor) | Coach view | Team view |
|---|---|---|---|
| Header, schedule, drills, diagrams, animation, intro clips, videos | ✔ | ✔ | ✔ |
| Give feedback | — | ✔ | ✘ |
| See feedback | all of it | their own only (Q1) | ✘ |
| "How was practice?" reactions, view log entries | reads them | writes own | writes own |

- R6.1 Feedback is per drill plus one overall box per practice; plain text; the author can edit or delete their own; each entry records author name, email and time.
- R6.2 The planner sees feedback inside the editor next to the drill it is about, with an unread count per practice, and can mark items resolved.
- R6.3 Feedback never travels with the practice document: nothing the team's browser downloads contains any feedback (see R8.3).
- R6.4 Coaching notes and the coaches line are shown in both views (Q2); hidden drills are in neither.

## 7. Request access

- R7.1 Shown to a signed-in **Unknown** persona. States who they are signed in as, offers "use a different account", and a **Request access** button with a choice of *I'm a coach* / *I'm a parent or family member* and an optional note ("Sam's grandma").
- R7.2 ✅ The request goes to a queue in the editor (badge on 👥 Team). The planner can **Approve as coach**, **Approve as family of `<player>`**, or **Deny**. Approving writes the email into the roster — which is what actually grants access (R2.3).
- R7.3 The requester sees "Request sent — you'll get access once the coach approves", and the page lets them in without a new link once approved (on next load or pull-to-reload).
- R7.4 One open request per account; a denied account cannot re-request for 7 days; requests reveal nothing about practices or the roster.
- R7.5 The app sends no email or push. ❓ Q3: is a badge in the editor enough, or should the screen also offer an "email the coach" button so you hear about it right away?

## 8. Authorization (server-side — the UI rules above are convenience, these are the guarantee)

- R8.1 Only planner emails can write practices, the roster, clips, videos, stages and access lists.
- R8.2 A coach can read a practice only if its stage is `coaches` or `team` **and** their email is in that practice's coach access list; a team member only if the stage is `team` **and** their email is in its team access list. The lists are materialised from the roster (+ extras) by the editor whenever the roster or the stage changes — Firestore rules cannot search the roster itself.
- R8.3 ✅ Truly private: the team reads a **separate published copy** of the practice containing only what the team view shows. Team accounts have no read path to the planner's working document, to feedback, to the view log, or to the roster.
- R8.4 Feedback: a coach may create / edit / delete only entries bearing their own uid and email, only on practices they can read; read access per Q1; the planner reads all.
- R8.5 Access requests: any signed-in account may create one document under its own uid and read only that one; the planner reads, resolves and deletes all.
- R8.6 Practice lists (`/coach`, `/team`) are served by queries the rules can verify ("practices whose coach list contains my email"), never by reading a collection and filtering in the browser.
- R8.7 Revocation takes effect on the next read; a device that gets permission-denied deletes its offline copy (shipped 2026-09-21).

## 9. Out of scope

Multiple planners or multiple organisations per deployment; email / push notifications; team members commenting;
coaches editing drills; per-drill visibility rules beyond today's "hidden drill".

## 10. Questions settled ("build it" — the proposals stand)

- **Q1 — Coaches do not see each other's feedback.** Each coach sees only their own notes; the planner sees all of it, attributed.
- **Q2 — The team view is the coach view.** Coaching notes and the coaches line are shown to families too; anything staff-only belongs in feedback or in a drill marked hidden (hidden drills are never published).
- **Q3 — Access requests** show as a badge on 👥 Team, and the request screen also offers an "email the coach" link, since the app sends no notifications.
- **Q4 — Migration:** a practice shared before stages existed becomes `team` if it had a team list, `coaches` if only a coach list, else `draft`; its typed emails stay as extras. The first planner sign-in after deploying publishes everything.

Simplifications made while building: feedback is **one note per coach per drill** (plus one overall) — editing replaces it, and a rewritten note counts as unresolved again; R7.4's "one open request per account" is the document id (`requests/{uid}`).

## 11. Acceptance checks (each becomes an automated browser test)

1. Signed out, `/` → sign-in; as planner → `/editor`; as roster coach → `/coach`; as roster parent → `/team`; as a stranger → `/request-access`.
2. Roster parent opens `/coach/<id>` of a released practice → lands on `/team/<id>`, Back does not bounce.
3. Roster parent opens `/team/<id>` while the practice is at `coaches` → "isn't available yet"; network log shows no practice data.
4. Coach opens `/editor` → `/coach`; no editor code or markup is present in the page.
5. With a team account's credentials, direct Firestore reads of the working document, feedback, view log and roster are all denied; the published copy contains no feedback.
6. Coach A cannot read Coach B's feedback (if Q1 = private); the planner sees both, attributed.
7. Stranger requests access → appears in the editor queue → approve as family → the same browser reaches `/team` after a reload, with no new link.
8. Remove a coach from the roster → their next load is denied and the offline copy is gone.
9. Old `#view=` / `#team=` links, plain and percent-encoded, land on the right new URL.
10. Every route reloads correctly on a hard refresh and from an installed home-screen icon, online and offline.
