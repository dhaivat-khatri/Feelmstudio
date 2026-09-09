// Dev harness — runs the real OSAI API with fake inference adapters so the whole
// UI/flow is clickable without Vertex/Parallel credentials or local model weights.
// Not for production. Run from apps/server:  npx tsx dev-fake-server.ts
import { serve } from '@hono/node-server';

import { createFakeAdapterRegistry, type InferenceRequest } from '@osai/inference';

import { createContext } from './src/context.js';
import { createApp } from './src/routes.js';

const text = {
  respond: (req: InferenceRequest) => {
    const sp = String(req.params?.systemPrompt ?? '');
    if (sp.includes('screenwriter')) {
      return {
        payload: {
          scenes: [
            'The keeper climbs the spiral stair at dusk, lamp oil sloshing in the can.',
            'He lights the great lens one final time while automation crews wait in the yard below.',
            'At dawn he walks out the door; the beam swings on behind him without a hand to turn it.',
          ],
        },
        model: 'fake-text',
      };
    }
    if (sp.includes('cinematographer')) {
      return { payload: { shotType: 'wide', framing: 'low angle', cameraMove: 'slow push-in', durationSeconds: 6 }, model: 'fake-text' };
    }
    if (sp.includes('composer')) {
      return {
        payload: { genre: 'ambient orchestral', instrumentation: 'strings, piano, low brass', tempo: 'slow, building', mood: 'wistful', direction: 'Sparse piano gives way to swelling strings as the keeper leaves.' },
        model: 'fake-text',
      };
    }
    return {
      payload: { tone: 'melancholic', palette: 'cool blues and warm lamplight', pacing: 'slow, contemplative', mood: 'wistful', format: 'Short Film', genre: 'Drama', runtimeMinutes: 3, characters: ['The Keeper'], locations: ['Lighthouse Tower', 'Rocky Shore'] },
      model: 'fake-text',
    };
  },
};

const ctx = createContext({
  projectsDir: process.env.OSAI_PROJECTS_DIR ?? './data/dev-projects',
  jobsDbPath: ':memory:',
  adapters: createFakeAdapterRegistry({ text }),
  researchAdapter: {
    research: async (q: string) => ({
      findings: [
        'Automation of lighthouses in Britain and Ireland began in the late 1960s; most kept resident keepers into the 1980s and 1990s.',
        'The last manned lighthouse in Ireland, Baily Lighthouse, was automated in 1997.',
        'Keepers who remain today do maintenance and technical work on automated systems, not lamp-lighting.',
      ],
      sources: [
        { title: 'Lighthouse keeper — Wikipedia', url: 'https://en.wikipedia.org/wiki/Lighthouse_keeper' },
        { title: 'Baily Lighthouse — Commissioners of Irish Lights', url: 'https://www.irishlights.ie/' },
      ],
    }),
  },
});

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: createApp(ctx).fetch, port }, (i) => {
  console.log(`\n  Fake OSAI API on http://localhost:${i.port}`);
  console.log('  Start the web app in another terminal:  cd apps/web && npm run dev\n');
});
