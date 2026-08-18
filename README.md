# Stremio TorrStream Addon

A Stremio addon that searches torrents via **Jackett** and streams them directly through **TorrServer** in FHD/1080p quality.

## How It Works

1. Stremio requests streams for a movie or series episode
2. The addon looks up the title via Cinemeta
3. It searches Jackett for matching 1080p/FHD torrents
4. Results are filtered by season/episode match (for series) and quality
5. The addon returns stream URLs pointing to your TorrServer instance
6. TorrServer streams the torrent directly to Stremio (no download needed)

## Prerequisites

- [Node.js](https://nodejs.org/) 18+ (or Docker)
- [Jackett](https://github.com/Jackett/Jackett) instance running and accessible
- [TorrServer](https://github.com/YouROK/TorrServer) instance running and accessible

## Configuration via Environment Variables

All configuration is done through environment variables. No hardcoded credentials.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `7000` | Port the addon listens on |
| `ADDON_PUBLIC_IP` | `0.0.0.0` | Public IP/hostname for the install link |
| `JACKETT_URL` | `https://jac.red` | Jackett server URL |
| `JACKETT_FALLBACK_URLS` | `https://jac-red.ru` | Fallback Jackett servers (comma-separated), tried if the primary returns nothing within the timeout |
| `JACKETT_TIMEOUT` | `5000` | Per-request timeout in ms before falling back to the next Jackett server |
| `JACKETT_API_KEY` | `` | Jackett API key |
| `TORRSERVER_HOST` | `localhost:9090` | TorrServer host:port |
| `TORRSERVER_USER` | `` | TorrServer username (optional) |
| `TORRSERVER_PASS` | `` | TorrServer password (optional) |

## Installation

### Option 1: Direct (Node.js)

```bash
git clone <your-repo-url>
cd stremio-jacred-torrserver
npm install

# Configure your environment
export JACKETT_API_KEY=your_jackett_key #default null
export TORRSERVER_HOST=your_server_ip:9090
export ADDON_PUBLIC_IP=your_public_ip

npm start
```

### Option 2: Docker

```bash
docker build -t stremio-torrstream .

docker run -d \
  --name stremio-torrstream \
  -p 7000:7000 \
  -e JACKETT_API_KEY=your_jackett_key \
  -e TORRSERVER_HOST=your_server_ip:9090 \
  -e ADDON_PUBLIC_IP=your_public_ip \
  stremio-torrstream
```

### Option 3: Docker Compose

```yaml
version: "3"
services:
  addon:
    build: .
    ports:
      - "7000:7000"
    environment:
      - JACKETT_API_KEY=your_jackett_key
      - TORRSERVER_HOST=your_server_ip:9090
      - ADDON_PUBLIC_IP=your_public_ip
```

## Installing in Stremio

Once the addon is running, install it in Stremio by visiting:

```
http://your_public_ip:7000/manifest.json
```

<<<<<<< HEAD
You can also use the **Strem
io Addon Search** and enter the URL above.
=======
>>>>>>> 3a57ca6d30b4729ed77125c1e75882495e134e6e

## Endpoints

- `/manifest.json` — Addon manifest
- `/stream/:type/:id.json` — Stream handler (used by Stremio)
- `/resolve?link=...&season=...&episode=...` — Resolve a torrent link to a stream URL

## Notes

- The addon filters for **1080p/FHD** quality only
- Results are sorted by **seeders** (highest first)
- Series episode matching supports multiple naming conventions (SxxExx, xxXxx, Cyrillic)
- Torrent results are cached for 15 minutes to avoid redundant Jackett queries
