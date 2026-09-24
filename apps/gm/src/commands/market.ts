import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import { CONSENSUS_SOURCES, MarketSnapshot, fetchConsensus, type MarketPlayer } from '@fha/market';
import { normalizeName } from '@fha/model';

const PATH = 'data/market/consensus.json';

export function readMarket(): MarketSnapshot | undefined {
  if (!existsSync(PATH)) return undefined;
  return MarketSnapshot.parse(JSON.parse(readFileSync(PATH, 'utf-8')));
}

export interface MarketIndex {
  byName: Map<string, MarketPlayer>;
  /** Surname -> players, used only when a full-name match fails. */
  bySurname: Map<string, MarketPlayer[]>;
  size: number;
  source: string;
}

export function indexMarket(snap: MarketSnapshot): MarketIndex {
  const byName = new Map<string, MarketPlayer>();
  const bySurname = new Map<string, MarketPlayer[]>();
  for (const p of snap.players) {
    const n = normalizeName(p.name);
    byName.set(n, p);
    const parts = n.split(' ');
    if (parts.length > 1) {
      const sur = parts.slice(1).join(' ');
      bySurname.set(sur, [...(bySurname.get(sur) ?? []), p]);
    }
  }
  return { byName, bySurname, size: snap.players.length, source: snap.source };
}

/**
 * Look up a player in the market index.
 *
 * Full normalized name first. A surname fallback applies only when it is unique *and*
 * the team agrees, because two players sharing a surname is common and a wrong join
 * produces a confident wrong ADP (§10.5).
 */
export function lookupMarket(
  index: MarketIndex,
  name: string,
  team: string,
): MarketPlayer | undefined {
  const n = normalizeName(name);
  const exact = index.byName.get(n);
  if (exact) return exact;

  const parts = n.split(' ');
  if (parts.length < 2) return undefined;
  const candidates = index.bySurname.get(parts.slice(1).join(' ')) ?? [];
  const sameTeam = candidates.filter((c) => c.team.toUpperCase() === team.toUpperCase());
  return sameTeam.length === 1 ? sameTeam[0] : undefined;
}

export function registerMarketCommands(program: Command): void {
  const market = program.command('market').description('public consensus rankings and ADP');

  market
    .command('pull')
    .description('fetch consensus rankings and average draft position')
    .action(async () => {
      const source = CONSENSUS_SOURCES[0];
      if (!source) throw new Error('no consensus source configured');
      console.log(`fetching ${source.name} ...`);
      const snap = await fetchConsensus(source);
      mkdirSync('data/market', { recursive: true });
      writeFileSync(PATH, JSON.stringify(snap), 'utf-8');
      const withAdp = snap.players.filter((p) => p.adp !== undefined).length;
      const multiPos = snap.players.filter((p) => p.positions.length > 1).length;
      console.log(
        `  ${snap.players.length} players, ${withAdp} with ADP, ${multiPos} multi-position -> ${PATH}`,
      );
    });

  market
    .command('show')
    .description('print the cached consensus board')
    .option('-n, --top <n>', 'rows', '30')
    .action((o: { top: string }) => {
      const snap = readMarket();
      if (!snap) throw new Error('no cached market data; run "fha market pull" first');
      const top = Number.parseInt(o.top, 10);
      console.log(`${snap.source} (${snap.players.length} players)\n`);
      for (const p of snap.players.slice(0, Number.isFinite(top) ? top : 30)) {
        console.log(
          `  ${String(p.rank).padStart(3)}  ${p.name.padEnd(24)} ${p.team.padEnd(4)} ` +
            `${p.positions.join(',').padEnd(8)} adp ${p.adp === undefined ? '  —' : p.adp.toFixed(1).padStart(5)}`,
        );
      }
    });
}
