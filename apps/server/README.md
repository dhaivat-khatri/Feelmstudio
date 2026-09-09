# @osai/server

The HTTP app layer: wires persistence, jobs, and inference into a running service
(Hono). `npm run dev` starts it on `:3000`; `npm start` runs it for a container
(reads `PORT`, serves `apps/web/dist` when `OSAI_WEB_DIR` is set).

## Craft memory

The Rooms tab's agent lessons persist to a JSON file, cross-project — path from
`OSAI_CRAFT_MEMORY`, default `<data>/craft-memory.json` next to the media dir.
On Cloud Run the container filesystem is ephemeral, so a hosted deployment loses
this on restart; a Firestore/volume backing is a drop-in behind `CraftMemoryStore`
(`src/craft-memory.ts`) when it matters.
