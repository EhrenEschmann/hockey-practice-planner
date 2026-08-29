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
- **Coaches**: a labelled diamond marker (label and colour editable). Drag the Coach button straight from the toolbar onto the ice to drop one where you want it — the same drag-and-drop works for skaters, cones, tires, pucks and nets.
- **Barricades**: click points to lay dividers across the ice; **Zones** mark labelled stations (drag a box, pick a colour, "Focus view on zone" to plan a drill in just that section).
- **Skaters with paths**: click to place a skater, keep clicking to add waypoints (or drag to draw freehand). Paths are smoothed splines. Each skater has a label, colour, role (F/D/G), speed (ft/s), start delay, puck-carrier flag and backward-skating flag.
- **Sticks**: every skater and coach holds a stick that points the way they face — along their path (reversed when skating backward), otherwise toward the nearest net (goalies and coaches face centre ice) or a manual **Facing** angle. A carried puck rides on the blade, leading the skater. During animation the blade stickhandles: it sits on the forehand side on straights, swings to the outside of turns, and is pulled to the far side of any cone or tire the skater passes within 6 ft of, so weaving through cones moves the puck from side to side.
- **Pucks**: use the Puck tool on a skater to give them a puck (or on open ice for a loose puck), or drag a puck onto a skater to hand it over. Select the puck to build its sequence: **Pass** to another skater when the carrier reaches a waypoint (the pass leads the receiver so it arrives where they will be), **Shoot** at a picked target (defaults to the nearest net), or **Pickup** of a loose puck. Pass/shot lines are drawn on the diagram and the puck follows the sequence during animation.
- **Animation**: play/pause/stop, scrub timeline, playback speed, loop. Total drill time is derived from each skater's path length ÷ speed + delay.
- **Arrows & text** for annotations (skate / pass / shot / backward styles).
- **Practice plan**: several drills per practice with duration and coaching notes; reorder, duplicate, delete. Practice library with team/date; everything autosaves to the browser (localStorage).
- **Undo/redo**, snap-to-1ft grid, keyboard nudging.
- **Export**: practice JSON (import on another machine), PNG of the current drill, and a printable practice sheet with every drill diagram and its notes.

## Keyboard

| Key | Action |
|---|---|
| V / H | Select / Pan |
| S, K, A | Skater, Coach, Arrow |
| C, T, P, N, O | Cone, Tire, Puck, Net, Obstacle |
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

Data model: a **practice** has `drills[]`; a **drill** has a `view` (viewBox in feet) and `objects[]`, each with a `type` (`skater`, `coach`, `cone`, `tire`, `puck`, `net`, `obstacle`, `barricade`, `zone`, `arrow`, `text`) and feet-based coordinates.
