import catalog from '../src/data/games.json';
import { handleRequest } from './api.ts';
import type { Env } from './types.ts';

const gameIds = new Set(catalog.games.map((game) => game.id));

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env, gameIds);
  },
};
