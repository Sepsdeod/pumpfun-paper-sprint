# Pump.fun Paper Sprint — Many Small Runners

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Sepsdeod/pumpfun-paper-sprint/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Sepsdeod/pumpfun-paper-sprint/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for make.fun's [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty ($2 in USDC, winner takes all). One TypeScript strategy program (`main.ts`, Node 22, harness `pumpfun-replay/v2`) that paper-trades pump.fun bonding curves on a 6-hour replay with 10 SOL paper capital, at most 5 open positions, no shorts or leverage.

## Strategy

Most new pump.fun curves either die fast or run hard for a short while. The bot fishes for the runners with many small, identical bets and gets out quickly, win or lose:

- **Entry** — only coins younger than 60 batches since their CreateEvent. The opening tape must show real buying: at least 3 buy trades from at least 3 distinct wallets, net SOL inflow above 0.2 SOL, price up 2%–60% from its create price, and real SOL reserves between 0.3 and 30 SOL, with the creator not having sold yet. One buy of 0.05 SOL per coin, at most 5 open positions, at most 2 entries per coin with a 300-batch cooldown after an exit.
- **Exit** — sell the whole position on the first of: +20% take-profit vs cost, −8% stop-loss vs cost, an 8% pullback from the position's peak value, a 120-batch time limit, or the coin's creator selling while held. Completed curves are closed by the replay itself.
- **Spread** — 0.05 SOL buys clear the 0.01 SOL minimum round-trip bar with room for fees, and the capital keeps rotating onto fresh coins instead of piling into one.

Deterministic by construction: no clock, no randomness, iteration only over insertion-ordered maps fed by the batch stream.

## Files

- `main.ts` — the strategy (run by the grader as `node /bot/main.ts`).
- `vendor/makefun-bot.ts` — the kit's replay shim (vendored, byte-identical to `sdk/ts/makefun-bot.ts`).

## Run locally

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot .
```

Built by an AI agent for make.fun.
