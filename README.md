# BR Stats

A ranked stats site for a small Battlerite OCE pick-up group. Admins log each
match (teams, champions, round score, and the scoreboard if there's a
screenshot) and the site works out MMR per season, leaderboards, player and
champion pages, the PvP and champion matrices, team balancing for the next
game, and a weekly recap. The live copy is at https://br.iarhm.xyz.

This is a fork of MagicMan-CT's
[Battlerite-Stat-Tracker](https://github.com/MagicMan-CT/Battlerite-Stat-Tracker),
which was first built with the Emergent app builder. I've kept working on it by
hand since then: rebranding, scoreboard screenshot reading, Discord login and
webhooks, season and MMR settings, admin tools and self-hosting scripts, among
other things. Most of that was built hand in hand with a Discord bot that runs
the group's pick-up lobbies, so the two were developed together.

## Branches

main is the website on its own. I've tried to take every bot endpoint out of
it (bot authentication, matches reported from Discord, link requests made
through the bot) while keeping all the website features, so it can be run
without the bot.

bot-integration is the same site plus the API the bot talks to. Site-only
changes are made on one branch and cherry-picked to the other. The bot itself
is in its own repo: https://github.com/dot-iiris/br-stats-bot

## Running it locally

You need Python 3.10 or newer, Node with Yarn 1, and MongoDB.

Backend, from backend/ (on Windows it's .venv\Scripts\ instead of .venv/bin/):

    python -m venv .venv
    .venv/bin/pip install -r requirements.txt
    cp .env.example .env
    .venv/bin/python -m uvicorn server:app --port 8001 --reload

Fill in .env before starting it. The admin account in .env (ADMIN_EMAIL /
ADMIN_PASSWORD) is created the first time the backend starts. Discord login and
the Discord webhooks are optional; leave those settings empty to go without
them.

Frontend, from frontend/:

    yarn install
    echo REACT_APP_BACKEND_URL=http://localhost:8001 > .env.development.local
    yarn start

The site opens on http://localhost:3000.

scripts/seed_demo.py fills an empty database with made-up players and matches
for testing. It logs in as admin@arenaops.gg / admin123, so use those in your
local .env if you want to run it.

Screenshot reading uses RapidOCR and OpenCV on the server, with no outside
service. It reads the in-game scoreboard's Average Total tab.

## Hosting

deploy/ has the scripts I use to run it on an Oracle Cloud free-tier Ubuntu
server behind nginx, with HTTPS from Let's Encrypt. deploy/README.md covers
setting one up. It's written around my own server and domain, so expect to
change a few names.
