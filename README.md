# Unispire WhatsApp agents

Two AI agents on two WhatsApp numbers, in one small Node service.

| Agent | Number | What it does |
|---|---|---|
| **Operations** (`src/ops.ts`) | "ops" number, added to every customer group | Reads all group messages. If a client waits longer than the limit, it privately reminds the responsible team member, then alerts you. Takes your instructions by private message, turns them into tasks, chases the team, and sends you a daily summary. It never writes to customers. |
| **Sales** (`src/sales.ts`) | "sales" number, one-to-one chats | Answers prospects, qualifies them, follows up when they go quiet (day 1, 3, 7), and hands over to a consultant when they want to proceed, pay, negotiate or talk to a person. Website enquiries are contacted automatically. |

## What you need
1. **Two WhatsApp numbers** (WhatsApp Business app is fine). Use dedicated numbers, not your personal one.
2. **Whapi.Cloud account** with two channels, one per number (scan the QR code for each). This is an unofficial
   "linked device" connection, the only way to be in existing groups. Keep volumes human: no bulk messaging.
3. **Claude API key** from console.anthropic.com.
4. **A server** with a public HTTPS address (Hostinger VPS), Node 24 or newer.

## Setup
```bash
npm install
cp .env.example .env                  # add the keys and tokens
cp config.example.json config.json    # your name, team names and numbers, hours, time limits
# edit knowledge.md: services, prices, timelines the sales agent may quote
npm test                              # replays fake messages through both agents; sends nothing
npm start
```
In Whapi, set each channel's webhook (event: messages, POST) to:
- ops channel: `https://agents.unispire.ae/webhooks/whapi/ops/<WEBHOOK_SECRET>`
- sales channel: `https://agents.unispire.ae/webhooks/whapi/sales/<WEBHOOK_SECRET>`

On the website, set `ENQUIRY_WEBHOOK_URL=https://agents.unispire.ae/webhooks/enquiry` and the same `ENQUIRY_WEBHOOK_SECRET` as here.

Start with `DRY_RUN=1` in `.env` to watch what it would send (in the logs) before letting it send for real.

## Day to day
- **Add the ops number to a customer group.** It starts tracking that group from the first message it sees.
- **Message the ops number privately** (from the owner's number in `config.json`), in plain language:
  - "What's happening with Acme?" / "Who is waiting for a reply?"
  - "Ask Ali to send the trade licence draft to Acme by tomorrow"
  - "Make Sana responsible for the Beta FZ group"
- **If the ops number is your own number**, write your instructions in WhatsApp's "message yourself" chat instead.
- **Team members** reply to the ops number privately: "task 4 is done, sent by email". You are told straight away.
- **To take over a sales chat**, just reply from the sales phone. The agent goes quiet in that chat for
  `humanTakeoverHours`. After a handover it stays out until you change the lead's status.

## Settings (`config.json`)
- `ops.monitorGroups`: `"all"`, or a list of group ids or parts of group names. Only these groups are watched;
  messages in any other group are ignored and not stored. Use a list when the number is also in personal or internal groups.
- `ops.replySlaMinutes`: how long a client may wait (in working hours) before the team member is reminded.
- `ops.escalateAfterMinutes`: when you are alerted if there is still no reply.
- `ops.nudgeWhere`: `dm` (private reminder, default), `team_group` (your internal team group, set `teamGroupId`),
  or `customer_group` (tags the team member inside the customer group, visible to the client).
- `team[].ids`: WhatsApp sometimes shows a group member under a private id instead of their phone number. If a
  team member's group replies are being counted as client messages, add that id here.

## Deployment (Hostinger VPS)
Runs as its own Docker project in `/opt/whatsapp-agents` on the VPS, next to the portal, listening on the
server's `127.0.0.1:8787` only. Settings live on the server in `/opt/whatsapp-agents/.env` and `config.json`.
```bash
# from this folder on the Mac (ssh alias "unispire-vps" is in ~/.ssh/config)
COPYFILE_DISABLE=1 tar czf - --exclude node_modules --exclude .env --exclude config.json --exclude '*.sqlite*' . \
  | ssh unispire-vps 'tar xzf - -C /opt/whatsapp-agents --no-same-owner && cd /opt/whatsapp-agents && docker compose up -d --build'
ssh unispire-vps 'cd /opt/whatsapp-agents && docker compose logs --tail 50'
```
To go live: fill in `.env` and `config.json` on the server, give the service a public HTTPS address (a subdomain
routed by the portal's Caddy to port 8787), set the Whapi webhooks, then remove `DRY_RUN=1` and restart.

## Not verified yet
Tested only with the simulator (`npm test`): stubbed AI replies and no real WhatsApp traffic. The first real run
with a Claude key and a Whapi channel should be done with `DRY_RUN=1`.
