# Self-hosting BR Stats on Oracle Cloud (or any Ubuntu server)

1. **Create the server**: Oracle Cloud → Compute → Instances → Create instance.
   Ubuntu 22.04/24.04, shape VM.Standard.A1.Flex (2 OCPU, 12 GB), on-demand capacity.
   Under *Advanced options → Management → Initialization script*, paste `oracle-init.sh`.
   Download the SSH private key.
2. **Open ports 80 and 443**: Networking → Virtual cloud networks → your VCN → Security
   lists → Default → Add ingress rules: source `0.0.0.0/0`, TCP, destination ports `80,443`.
   (The server's own firewall is opened by the setup script.)
3. **DNS**: point your domain (e.g. `stats.example.com`, A record) at the instance's public IP.
4. **Upload the website and its settings** from the PC: `deploy-website.bat`. It sends
   `backend/.env.live` (whenever it has changed) and runs `brstats-finish` on the server,
   which starts the website and gets the HTTPS certificate.
5. **Upload the bot**: `deploy-bot.bat` sends the bot and its `.env.live`
   (add `-WithDb` to also copy the PC's database when moving an existing site).

## Day to day
- Update to the latest code: `ssh ubuntu@<ip>` then `sudo brstats-update`
- Logs: `journalctl -u brstats-api -f`, `journalctl -u brstats-bot -f`
- Restart: `sudo systemctl restart brstats-api brstats-bot`
- Settings: `/opt/brstats/backend.env` (website), `/opt/brstats/bot/.env` (bot); restart after editing
- Database copy: `/opt/brstats/venv/bin/python /opt/brstats/site/deploy/db_transfer.py export backup.jsonl.gz --env /opt/brstats/backend.env`
