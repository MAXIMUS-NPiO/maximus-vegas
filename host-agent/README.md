# MAXIMUS native host agent

This Linux adapter runs an explicitly configured game on a new, authenticated Xvfb display inside a Bubblewrap sandbox. It sends the game video and optional isolated PulseAudio output over WebRTC and accepts a bounded keyboard/mouse protocol. It never captures the operator's existing desktop, microphone, home directory or portal credentials. It does not accept executable names, shell commands, file paths or game downloads from peers.

The browser-host alternative runs MAXIMUS Arena on the host's canvas and sends real video and inputs between peers. Browser screen sharing is view-only for installed games.

## Installation

Use a dedicated non-root Linux account. Install Python 3.10+, FFmpeg with X11 and Pulse support, Xvfb, xauth, xdotool, Bubblewrap and PulseAudio using the operating system's package manager. Unprivileged user namespaces must be enabled for Bubblewrap. Do not disable the sandbox to work around a deployment failure.

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp config.example.json config.json
```

Edit the game directory and command to match a legitimately installed game. The example is a path template, not an installed or publisher-approved game. Only the selected game directory is mounted at `/game`; the game executable must be below `/game`. Writable state goes in an ephemeral `/home/player` and is erased after each session. Install required runtime dependencies separately. `network: false` isolates the game from networking; enable it only when the approved game needs online services. Host-agent communication uses the host network independently of game networking.

The default Xvfb adapter is a software-rendered virtual display. Dedicated GPU-backed Xorg/container integration, game-launcher authentication, anti-cheat compatibility and publisher streaming rights require separate validation on the real host. No GPU benchmark or compatibility is inferred from the submitted CPU/GPU labels. Game credentials must not be shared with players or placed in the game directory. Windows/macOS native control is not provided by this Linux adapter.

Register the host on the portal with only the games actually configured and wait for independent infrastructure review. In the host workspace, create a host key and set `MV_HOST_KEY` in the service's secret environment. Do not save it to source control or command history. Configure the portal HTTPS origin and set `acceptSessions: true` when ready to accept requests. Run:

```sh
.venv/bin/python agent.py --config config.json
```

A host accepts one session at a time. Leases are bounded to an hour. Stale requests expire, and lost heartbeats remove availability. Revoking the host key stops authenticated agent operations. The browser client can terminate at any time. Both sides must confirm a delivered session and at least five minutes of metered connectivity for the bounded internal contribution credit; this is not a financial payment.

## Network configuration

The portal supports `MV_STUN_URLS`, `MV_TURN_URLS`, `MV_TURN_SECRET` (32+ characters), and `MV_RELAY_ONLY=1`. TURN URLs are comma separated and the server uses temporary credentials derived from the shared secret, compatible with the TURN REST authentication convention. Keep the shared secret on the portal and TURN server only. Production relay bandwidth, reachable ports, certificate trust and capacity must be verified before advertising public service. No paid relay is provisioned by this repository.

The current Python adapter gathers the full ICE offer before sending it. Browser trickle candidates are queued until the answer is applied. The browser honours relay-only mode; this adapter refuses to start in relay-only mode, because the Python library does not expose the same transport-policy setting. Use the browser transport for relay-only sessions until a native transport with enforced relay support is available.

## Checks

```sh
python3 -m unittest discover -s host-agent -p 'test_*.py'
```

The protocol tests cover allowed input, rejected shell/meta keys, bounded coordinates, and executable confinement. Real-host acceptance additionally requires an end-to-end audio/video/input session, interruption cleanup, clean-room game launch, two-device NAT testing, and measured CPU/GPU/latency results. The portal's isolated tests exercise host authorization, signalling isolation, lease expiry, key revocation and replay-safe contribution credits.

Dependencies: aiortc and PyAV (BSD-3-Clause), FFmpeg (build-dependent LGPL/GPL), X.Org tools (their published permissive licenses), Bubblewrap (LGPL-2.0-or-later), PulseAudio (LGPL-2.1-or-later). The adapter is original project code; these dependencies remain separately licensed. No game binary is distributed.
