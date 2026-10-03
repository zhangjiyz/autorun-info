import data from '../data/games.json';

export const games = data.games;
export const source = data.source;
export type Game = (typeof games)[number];
export const categories = [...new Set(games.map((game) => game.category))];
export const statusLabel = (value: string) =>
  ({ verified: '已验证', partial: '部分验证', unverified: '验证待整理' })[value] || '验证待整理';
