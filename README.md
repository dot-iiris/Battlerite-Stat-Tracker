# BR Stats

BR Stats is a ranked statistics site for a small Battlerite OCE pick-up group.
Administrators log each match, recording the teams, champions and round score,
along with the scoreboard figures when a screenshot is available. From these
records the site calculates seasonal MMR and produces leaderboards, player and
champion pages, PvP and champion matrices, balanced teams for upcoming games,
and a weekly recap.

The site is currently in use by the group at https://br.iarhm.xyz, where the
statistics are open for anyone to view.

The project is a fork of MagicMan-CT's
[Battlerite-Stat-Tracker](https://github.com/MagicMan-CT/Battlerite-Stat-Tracker),
which was originally generated with the Emergent app builder. Development has
since continued by hand, adding a new brand, scoreboard screenshot reading,
Discord login and webhooks, season and MMR settings, administrative tools and
self-hosting scripts, among other changes. Much of this work was carried out
alongside a Discord bot that runs the group's pick-up lobbies, and the two were
developed in parallel.

## Branches

The main branch contains the website on its own. The bot's endpoints, namely
bot authentication, matches reported from Discord and link requests made
through the bot, have been removed from it while the website features remain,
so that the site can be run without the bot.

The bot-integration branch contains the same site together with the API that
the bot relies on. Changes that concern only the website are made on one
branch and cherry-picked to the other. The bot is maintained in a separate
repository: https://github.com/dot-iiris/br-stats-bot

## Running locally

The project requires Python 3.10 or newer, Node with Yarn 1, and MongoDB.

The backend is run from backend/ (on Windows, .venv\Scripts\ replaces
.venv/bin/):

    python -m venv .venv
    .venv/bin/pip install -r requirements.txt
    cp .env.example .env
    .venv/bin/python -m uvicorn server:app --port 8001 --reload

The .env file should be completed before the backend is started. The
administrator account it defines (ADMIN_EMAIL and ADMIN_PASSWORD) is created
on the first start. Discord login and the Discord webhooks are optional and
are disabled when their settings are left empty.

The frontend is run from frontend/:

    yarn install
    echo REACT_APP_BACKEND_URL=http://localhost:8001 > .env.development.local
    yarn start

The site is then available at http://localhost:3000. For production builds,
REACT_APP_SITE_URL should be set to the site's public address (for example
https://stats.example.com) so that link previews in Discord and other apps can
find the preview image.

The script scripts/seed_demo.py populates an empty database with fictitious
players and matches for testing. It signs in as admin@arenaops.gg with the
password admin123, so those credentials must be set in the local .env for it
to run.

Screenshot reading is performed on the server with RapidOCR and OpenCV and
does not depend on any external service. It reads the Average Total tab of the
in-game scoreboard.

## Hosting

The deploy/ directory contains scripts for running the site on an Oracle Cloud
free-tier Ubuntu server behind nginx, with HTTPS certificates from Let's
Encrypt. Setup is described in deploy/README.md. The scripts are written for a
particular server and domain, so some names will need to be changed for other
deployments.

## AI assistance

Much of the development since the fork, including new features, fixes and the
hosting scripts, was carried out with the assistance of Claude, an AI model
made by Anthropic, used as a coding agent. The work was done at the
maintainer's direction, and commits are authored by the maintainer without
recording this assistance individually. As with any software, the code may
contain errors and is provided as is.
