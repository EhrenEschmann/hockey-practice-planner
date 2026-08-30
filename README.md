# Hockey Practice Planner

A browser-based tool for designing hockey practices: draw drills on a rink, place cones/tires/nets/obstacles, barricade off sections of the ice, and animate skaters moving through the drill.

No build step and no dependencies — plain HTML, CSS and ES modules.

## Run

```bash
npm start          # serves on http://localhost:5173
```

(Any static file server works, e.g. `python3 -m http.server 5173`.)

## Features

- **Rink canvas** in real feet (200 × 85 NHL rink) with view presets — full ice, either half, either end zone, neutral zone — plus wheel zoom and Space/middle-mouse pan so you can plan on any piece of the ice.
- **Equipment tools**: cones, tires, pucks, nets (rotatable), and obstacle pads (drag a box, any size/rotation).
- **Raised pad on tires**: a pad resting on two tires (click to place; length/depth/rotation editable). It's drawn above the players, and a skater whose path runs through it slides under during animation — body stretched flat along their heading, puck pushed straight ahead of them.
- **Small cones for stickhandling**: click to place one, or drag to lay a row about 3 ft apart. When a puck carrier's path runs along the row, the animation stickhandles the puck through them — alternately left and right of each cone — while the skater glides along the line.
- **Goalies**: the Goalie tool (or dragging its button) near a net puts a goalie in that net's crease facing out — it follows the net's rotation; a net's panel also has *Add goalie*. Goalies are skaters with role G (square marker) and can be given paths, pucks and passes like anyone else.
- **Coaches**: a labelled diamond marker (label and colour editable). Drag the Coach button straight from the toolbar onto the ice to drop one where you want it — the same drag-and-drop works for skaters, cones, tires, pucks and nets. Coaches take part in puck play like a skater: they can receive passes, carry a puck (Puck tool on a coach, drop a puck on them, or *Give puck*), and pass or shoot it; **Facing** sets which way they hold it while standing. They can also move — use the Skater tool on a coach to give them a path (speed defaults to 10 ft/s).
- **Triggered starts**: any skater or coach can be set to start moving *when another player reaches a given waypoint* (their panel → "Starts moving"), with the start delay added on top — e.g. a coach who skates in once #1 reaches the blue line, or #2 who goes when #1 hits waypoint 2.
- **Barricades**: click points to lay dividers across the ice; **Zones** mark labelled stations (drag a box, pick a colour, "Focus view on zone" to plan a drill in just that section).
- **Skaters with paths**: click to place a skater, keep clicking to add waypoints (or drag to draw freehand). Paths are smoothed splines. Each skater has a label, colour, role (F/D/G), speed (ft/s), start delay, puck-carrier flag and backward-skating flag.
- **Puck carrying**: a carried puck leads the skater — it sits about 4.5 ft ahead in the direction they face (along their path, reversed when skating backward; a stationary skater faces the nearest net, or a manual **Facing** angle). During animation the puck stickhandles: it rides on the forehand side on straights, swings to the outside of turns, and is pulled to the far side of any cone or tire the skater passes within 6 ft of, so weaving through cones moves the puck from side to side.
- **Pucks**: use the Puck tool on a skater to give them a puck (or on open ice for a loose puck), or drag a puck onto a skater to hand it over. Select the puck to build its sequence: **Pass** to another skater when the carrier reaches a waypoint (the pass leads the receiver so it arrives where they will be), **Shoot** at a picked target (defaults to the nearest net), or **Pickup** of a loose puck. Each event fires either when the skater reaches a waypoint or at a spot **marked on the path**: click *Mark on path* and then the path, or drag the P / S / U marker along the path on the ice (stored as feet along the path, so it moves with the skater). A pass can be timed by either end: *released when the passer is at …* or *arriving as the receiver reaches …* — the latter back-computes the release so the puck meets a moving receiver exactly at their waypoint or R mark (handy for a coach or a waiting skater feeding a player on the move); if the passer doesn't have the puck early enough, the row warns that it arrives late. Tick **off the boards** for a bank pass: the puck goes passer → boards → receiver via a bounce point that snaps to the boards (drag the B marker or click *Bounce point…*), and the receiver may be the passer themselves — skate on and collect your own bank pass. Pass/shot lines and the markers are drawn on the diagram and the puck follows the sequence during animation.
- **Animation**: play/pause/stop, scrub timeline, playback speed, loop. Total drill time is derived from each skater's path length ÷ speed + delay.
- **Arrows & text** for annotations (skate / pass / shot / backward styles).
- **Practice plan**: several drills per practice with duration and coaching notes; reorder, duplicate, delete. Practice library with team/date; everything autosaves to the browser (localStorage).
- **Undo/redo**, snap-to-1ft grid, keyboard nudging.
- **Export**: practice JSON (import on another machine), PNG of the current drill, and a printable practice sheet with every drill diagram and its notes.

## Keyboard

| Key | Action |
|---|---|
| V / H | Select / Pan |
| S, K, G, A | Skater, Coach, Goalie, Arrow |
| C, M, T, P, N, O, R | Cone, Small cone, Tire, Puck, Net, Obstacle, Raised pad |
| B, Z, X, E | Barricade, Zone, Text, Erase |
| Enter / Esc | Finish current path or polyline |
| Delete | Remove selection |
| Arrows (+Shift) | Nudge selection 1 ft (5 ft) |
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
js/sim.js        skater timing and puck timeline (carry / pass / shoot / pickup)
js/geometry.js   splines, arc-length sampling, path simplification
serve.js         zero-dependency static server
```

Data model: a **practice** has `drills[]`; a **drill** has a `view` (viewBox in feet) and `objects[]`, each with a `type` (`skater`, `coach`, `cone`, `minicone`, `tire`, `raisedpad`, `puck`, `net`, `obstacle`, `barricade`, `zone`, `arrow`, `text`) and feet-based coordinates.
