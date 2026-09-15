# Hockey Practice Planner

A browser-based tool for designing hockey practices: draw drills on a rink, place cones/tires/nets/obstacles, barricade off sections of the ice, and animate skaters moving through the drill.

No build step and no dependencies — plain HTML, CSS and ES modules.

## Run

```bash
npm start          # serves on http://localhost:5173
```

(Any static file server works, e.g. `python3 -m http.server 5173`.)

## Cloud save (Firebase)

Practices auto-save to Firebase so they follow you between devices. Without a config the app keeps working local-only (browser storage), exactly as before.

1. Create a Firebase project, add a **Web app**, and copy its config.
2. Enable **Authentication → Sign-in method → Google**.
3. Create a **Firestore** database and paste [firestore.rules](firestore.rules) as its rules (each user can only read/write their own practices; a practice can additionally be *read* by the Google accounts listed in its **Coach emails** — presentation mode).
4. `cp js/firebase-config.example.js js/firebase-config.js` and paste the config in. (The file is git-ignored; putting it at the project root as `firebase-config.js` works too.)
5. Reload: a **Sign in** button appears in the top bar.

**Two share audiences.** Each practice has two independent, read-only share lists in **+ Practice**, each with its own link:

| | Who | Link | Sees |
|---|---|---|---|
| **Coaches** | assistant coaches | 🔗 Coach link (`#view=…`) | the full plan — diagrams, animations, **coaching notes and assignments** |
| **Team** | players' parents & grandparents | 🔗 Team link (`#team=…`) | the schedule and drill diagrams/animations, **without** coaching notes or the coaches line |

**＋ from roster** fills either list from 👥 Team (coach emails / family contact emails). A viewer signs in with Google and sees only the practices they are listed on. **Only accounts in `OWNER_EMAILS` (js/main.js) get the practice-creation interface** — anyone else who opens the app root is told to use their share link. That is a UI gate; the real protection is [firestore.rules](firestore.rules): nobody can write another account's practices, and readers only ever read the practices whose lists carry their email.

**Presentation mode.** Open practice details (**+ Practice**) and list your assistant coaches' Google emails under **Coach emails**, then hit **🔗 Coach link** and send it to them. A coach who opens the link signs in with Google and gets a thin read-only view of the practice — header, each drill's diagram, timing and notes — that updates live as you edit. The **📺 Present** button in the top bar opens the same view of your own practice in a new tab (works offline too) — the presentation is its own destination, with no way through to the editor. This needs the current [firestore.rules](firestore.rules) deployed.

**On a phone (rink mode).** The share link is built for a phone in a glove. On a touch screen the presentation opens in **rink mode**: one drill at a time, everything on one screen with nothing to scroll — the diagram shrinks to the room left under the title and play bar, and long notes or rules scroll inside their own box —  with a big ▶, a fat scrubber, ‹ / › buttons and swipe to move between drills, and a tap on the counter to jump straight to any drill. Tapping the diagram itself plays it. If the practice is today and has a start time, the link opens on the drill that is on right now. In portrait, **↻** turns a full-ice diagram sideways so it fills the phone; turn the phone on its side and the diagram fills the height with the name, controls and notes beside it. **⛶** goes full screen (Android; on iPhone use Safari's *Add to Home Screen* instead), the screen stays awake while the plan is up, and **☰** switches to the whole plan as a scroll-through — the layout a laptop or a rink TV gets by default. ← / → / Space work there too.

**Who has looked.** **👁 Views log** in **+ Practice** is an audit log of the practice: for every drill, who viewed it (a card on screen for two seconds) and who played its animation, with first and last times, which link they came through and whether it was a phone — plus a recent-activity feed. Viewers' phones append the records (in their own name only, at most one view and one play per drill every five minutes, queued while offline); only the owner can read or clear the log. Your own previews aren't counted. Needs the current [firestore.rules](firestore.rules) deployed.

**↻ Resync** in the viewer's top bar refetches everything for that practice — the plan, any intro you recorded or re-recorded since the phone last looked, and the newest app version — without signing out. (Re-recorded intros also replace the old copy on their own the next time a phone loads the practice online.)

**Offline at the rink.** A service worker ([sw.js](sw.js)) caches the app and the viewer keeps a local copy of the last practice it loaded, so a coach who opens the share link once with internet can reopen it cold at the rink — drills, notes and animations all work, with an "Offline copy from …" banner. The strategy is network-first: whenever there *is* connectivity, every load fetches the latest deploy and the freshest practice, so updates are never missed. (Service workers need HTTPS or localhost, so offline only arms on real hosting, not on a LAN-IP dev server.)

With a config in place the app is **gated**: a sign-in screen covers the planner until you sign in with Google (and comes back when you sign out), so nothing can be created or edited anonymously. If a different Google account signs in on the same browser, the previous account's locally cached practices are cleared first, so accounts never mix. Once signed in, every edit is written about a second after you stop making changes (status shows *Saving… / Saved to cloud ✓*), deletes propagate, and edits from another device appear live. On sign-in, local and cloud practices are merged — the newer copy of each practice wins and practices that exist only on one side are copied to the other. Data lives at `users/{uid}/practices/{practiceId}`, one document per practice. The SDK is loaded from Google's CDN, so there is still no build step.

## Features

- **Rink canvas** in real feet (200 × 85 NHL rink) with view presets — full ice, either half, either end zone, neutral zone — plus wheel zoom and Space/middle-mouse pan so you can plan on any piece of the ice.
- **Equipment tools**: cones, tires, pucks, nets (rotatable), and obstacle pads (drag a box, any size/rotation).
- **Raised pad on tires**: a pad resting on two tires (click to place; length/depth/rotation editable). It's drawn above the players, and a skater whose path runs through it slides under during animation — body stretched flat along their heading, puck pushed straight ahead of them.
- **Jump pad**: a low striped pad (click to place; length/depth/rotation editable). A skater whose path crosses it jumps over during animation — the figure rises and lands in an arc timed across the pad along their direction of travel, with a shadow falling away beneath — and the puck is pushed straight ahead first.
- **Small cones for stickhandling**: click to place one, or drag to lay a row about 3 ft apart. When a puck carrier's path runs along the row, the animation stickhandles the puck through them — alternately left and right of each cone — while the skater glides along the line.
- **Goalies**: the Goalie tool (or dragging its button) near a net puts a goalie in that net's crease facing out — it follows the net's rotation; a net's panel also has *Add goalie*. Goalies are skaters with role G (square marker) and can be given paths, pucks and passes like anyone else.
- **Coaches**: a labelled diamond marker (label and colour editable). Drag the Coach button straight from the toolbar onto the ice to drop one where you want it — the same drag-and-drop works for skaters, cones, tires, pucks and nets. Coaches take part in puck play like a skater: they can receive passes, carry a puck (Puck tool on a coach, drop a puck on them, or *Give puck*), and pass or shoot it; **Facing** sets which way they hold it while standing. They can also move — use the Skater tool on a coach to give them a path (speed defaults to 10 ft/s).
- **Triggered starts**: any skater or coach can be set to start moving *when another player reaches a given waypoint* (their panel → "Starts moving"), with the start delay added on top — e.g. a coach who skates in once #1 reaches the blue line, or #2 who goes when #1 hits waypoint 2.
- **Barricades**: click points to lay dividers across the ice; **Zones** mark labelled stations (drag a box, pick a colour, "Focus view on zone" to plan a drill in just that section).
- **Offense / defense**: an **O / D** switch under the Skater tool makes new skaters blue (offense) or red (defense), numbered separately per side; a skater's **Side** can be changed in its panel (which recolours it), and the colour swatch is still there for anything custom.
- **Skaters with paths**: click to place a skater, keep clicking to add waypoints (or drag to draw freehand). Paths are smoothed splines. Each skater has a label, colour, role (F/D/G), speed (ft/s), start delay, puck-carrier flag and backward-skating flag.
- **Puck carrying**: a carried puck leads the skater — it sits about 4.5 ft ahead in the direction they face (along their path, reversed when skating backward; a stationary skater faces the nearest net, or a manual **Facing** angle). During animation the puck stickhandles: it rides on the forehand side on straights, swings to the outside of turns, and is pulled to the far side of any cone or tire the skater passes within 6 ft of, so weaving through cones moves the puck from side to side.
- **Puck pile**: a heap of pucks (count editable) that skaters take from. *Take puck from pile* in a skater's panel adds a puck that sits in the pile until that skater's path passes it, then rides with them — add passes/shots after. The pile's panel can *Give a puck to…* any player, and the Puck tool on a pile takes a loose one. The pile's badge counts down during animation, and pucks in it move with the pile.
- **Pucks**: use the Puck tool on a skater to give them a puck (or on open ice for a loose puck), or drag a puck onto a skater to hand it over. Select the puck to build its sequence: **Pass** to another skater when the carrier reaches a waypoint (the pass leads the receiver so it arrives where they will be), **Shoot** at a picked target (defaults to the nearest net), or **Pickup** of a loose puck. Each event fires either when the skater reaches a waypoint or at a spot **marked on the path**: click *Mark on path* and then the path, or drag the P / S / U marker along the path on the ice (stored as feet along the path, so it moves with the skater). Every pass also shows a green **→** marker where it arrives; drag it along the receiver's path to put the arrival exactly where you want (that times the pass by the receiver). A pass can be timed by either end: *released when the passer is at …* or *arriving as the receiver reaches …* — the latter back-computes the release so the puck meets a moving receiver exactly at their waypoint or R mark (handy for a coach or a waiting skater feeding a player on the move); if the passer doesn't have the puck early enough, the row warns that it arrives late. Tick **off the boards** for a bank pass: the puck goes passer → boards → receiver via a bounce point that snaps to the boards (drag the B marker or click *Bounce point…*), and the receiver may be the passer themselves — skate on and collect your own bank pass. Pass/shot lines and the markers are drawn on the diagram and the puck follows the sequence during animation.
- **Stations & rules-only drills**: a drill doesn't need skaters and paths. Drag a **Zone** over the space you want, give it a title and type its **Constraints** one per line (e.g. *2 touches max · No passes back · Score from below the dots*). The rules are drawn inside the zone on the ice and on the printed sheet, and every viewer card lists them under the diagram with a **🔊 Read rules** button that reads the title and each constraint aloud in turn, highlighting the line being spoken. Several zones in one drill make a set of stations; **🔊 Read aloud** in the zone's panel previews it.
- **Nothing gets lost off the canvas**: every position in the Selection panel is typed as well as dragged — an object's x / y in the header, each waypoint and barricade / arrow point in its list, and a shot's target and bounce point in the puck's event row — so anything that has drifted outside the view can be brought back by number. The view bar's **⤢ Fit all** zooms out to show the whole rink plus everything in the drill, and an amber **N off-screen** badge appears (and does the same when clicked) whenever a point is outside the canvas.
- **Waypoint list**: with a skater or coach selected, the Selection panel lists every waypoint with its position and flags. Hover a row to light that handle up on the ice; the row's buttons set a pivot (⇄), a full stop (⏸) or a voice cue (🔊), and ✕ removes the waypoint — the easy way to delete one that is buried under cones or other skaters.
- **Intro in your own voice**: the 🎙 button on a drill row opens a recorder — record yourself introducing the drill (up to 90 s), listen back, re-record or delete. Whenever ▶ is pressed from the start — in the editor or on a coach's phone — the clip plays first and the animation follows; ⏸ during the clip skips it, and muting 🔊 voice skips it too. A rules-only drill gets a ▶ for the intro alone. Clips are kept out of the practice document: they're stored on the device (IndexedDB) and, when signed in, as one small Firestore document per clip beside the practice (`…/practices/{id}/clips/{drillId}`, readable by the same coaches and families — this needs the current [firestore.rules](firestore.rules) deployed). The recorder shows **☁ in the cloud** once the copy is up; if the upload was refused (rules not deployed yet) or you were offline, it says so, keeps the clip on that device, offers **☁ Upload now**, and retries by itself the next time you sign in there. Note that the on-device copy belongs to the browser and address you recorded in — a clip recorded on `localhost` reaches the live site only through the cloud copy. A coach's phone downloads a clip the first time it shows the practice and keeps it for the rink. Duplicating a drill or practice doesn't copy the recording.
- **Voice cues**: select a skater or coach and type what to say at their start or at any waypoint (*Voice cue at* in the Selection panel; cued waypoints show a yellow badge on the ice). During playback — in the editor and in the coaches' phone view alike — each cue is read aloud by the device the moment that player reaches the point, and shown as a caption under the rink so it still works on a loud bench or a muted phone. 🔊 on the animation bar mutes and unmutes; the choice is remembered per device. A phone speaks only after the play button has been tapped once.
- **Animation**: play/pause/stop, scrub timeline, playback speed, loop. Total drill time is derived from each skater's path length ÷ speed + delay.
- **Arrows & text** for annotations (skate / pass / shot / backward styles).
- **Drill library**: *📚 From library…* in the Drills panel opens every drill from all of your practices — searchable, with a rink thumbnail and the practice it came from — and adds a copy of any drill to the practice you're on. To build a practice from existing drills: *+ Practice*, then add from the library.
- **Practice plan**: several drills per practice with duration and coaching notes; reorder, duplicate, delete. Practice library with team/date; everything autosaves to the browser (localStorage).
- **Undo/redo**, snap-to-1ft grid, keyboard nudging.
- **Export**: practice JSON (import on another machine), PNG of the current drill, and a printable practice sheet with every drill diagram and its notes.

## Keyboard

| Key | Action |
|---|---|
| V / H | Select / Pan |
| S, K, G, A | Skater, Coach, Goalie, Arrow |
| C, M, T, P, L, N, O, R, J | Cone, Small cone, Tire, Puck, Puck pile, Net, Obstacle, Raised pad, Jump pad |
| B, Z, X, E | Barricade, Zone, Text, Erase |
| Enter / Esc | Finish current path or polyline |
| Delete | Remove selection |
| Arrows (+Shift) | Nudge selection 1 ft (5 ft) |
| PageUp / PageDown | Previous / next drill |
| Ctrl+Z / Ctrl+Y | Undo / Redo |
| Space (tap) | Play / pause animation |
| Space (hold) + drag | Pan |

## Layout

```
index.html       app shell & panels
css/style.css
js/main.js       tools, pointer/keyboard handling, animation, sidebar, import/export
js/render.js     SVG rendering of drill objects (pure functions of state)
js/rink.js       rink drawing, view presets, SVG styles
js/store.js      practice/drill data model, localStorage persistence, undo/redo
js/cloud.js      Firebase auto-save & live sync (Firestore + Google sign-in); no-op without a config
js/sim.js        skater timing and puck timeline (carry / pass / shoot / pickup)
js/geometry.js   splines, arc-length sampling, path simplification
js/icons.js      generated Lucide icon set (npm run icons regenerates from lucide-static)
serve.js         zero-dependency static server
```

Data model: a **practice** has `drills[]`; a **drill** has a `view` (viewBox in feet) and `objects[]`, each with a `type` (`skater`, `coach`, `cone`, `minicone`, `tire`, `raisedpad`, `jumppad`, `pile`, `puck`, `net`, `obstacle`, `barricade`, `zone`, `arrow`, `text`) and feet-based coordinates.
