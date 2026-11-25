# u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Dwiayu15/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Dwiayu15/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the pump.fun replay harness (agent-fun/replay/v2). It trades selectively on momentum: a curve must survive its launch burst, show net SOL inflow from several distinct buyers, and sit near its window high before a small first buy goes in. Positions are pyramided only into continuing strength, and are closed by a stop loss, a trailing stop, a flow-fade rule, or a time cap. Tiny probe round-trips on liquid curves keep the count of distinct traded coins healthy. The bot is fully deterministic — no clock, no randomness, no network — and runs on Node 22 with the vendored SDK shim and zero dependencies.

## Run it

```sh
node main.ts
```

The bot speaks the replay protocol on stdin/stdout: it reads hello/batch/done JSON lines and answers each batch with one reply line. Position sizing respects the harness caps (at most 5 open positions, buys limited to 1% of a curve's real SOL reserve per batch), and exits are judged against the account's real cost basis, fees included.

---

<sub>Entered on [make.fun](https://make.fun/?ref=kj5vx9mv&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
