"""Linux P2P host: dedicated display, sandboxed game, scoped credential, no peer shell."""
import argparse
import asyncio
import contextlib
import fractions
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import subprocess
import tempfile
import time
import urllib.request
import uuid
from protocol import KEYS, input_command, validate_config

from aiortc import RTCPeerConnection, RTCConfiguration, RTCIceServer, RTCSessionDescription, VideoStreamTrack, AudioStreamTrack
from aiortc.sdp import candidate_from_sdp
from av import VideoFrame, AudioFrame

class Portal:
    def __init__(self, origin, token):
        self.url = origin.rstrip("/") + "/api/p2p/agent"
        self.token = token

    async def call(self, action, **fields):
        body = json.dumps({"action": action, **fields}).encode()
        def send():
            request = urllib.request.Request(self.url, body, headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json"}, method="POST")
            # Do not follow redirects carrying the machine credential.
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, *args, **kwargs): return None
            with urllib.request.build_opener(NoRedirect).open(request, timeout=12) as response:
                payload = response.read(500_001)
                if len(payload) > 500_000: raise RuntimeError("Portal response too large")
                return json.loads(payload)
        return await asyncio.to_thread(send)

class FrameTrack(VideoStreamTrack):
    def __init__(self, pipe, width, height):
        super().__init__(); self.pipe, self.width, self.height = pipe, width, height

    async def recv(self):
        pts, time_base = await self.next_timestamp()
        raw = await self.pipe.readexactly(self.width * self.height * 3)
        frame = VideoFrame(self.width, self.height, "rgb24")
        frame.planes[0].update(raw); frame.pts, frame.time_base = pts, time_base
        return frame

class SoundTrack(AudioStreamTrack):
    def __init__(self, pipe): super().__init__(); self.pipe, self.pts = pipe, 0
    async def recv(self):
        raw = await self.pipe.readexactly(960 * 2 * 2)
        frame = AudioFrame(format="s16", layout="stereo", samples=960)
        frame.planes[0].update(raw); frame.sample_rate = 48000
        frame.pts, frame.time_base = self.pts, fractions.Fraction(1, 48000); self.pts += 960
        return frame

class GameBox:
    def __init__(self, config, game):
        self.config, self.game = config, config["games"][game]
        self.directory = tempfile.TemporaryDirectory(prefix="maximus-session-")
        self.processes = []; self.async_processes = []; self.held = set(); self.buttons = set()
        self.last_input = time.monotonic(); self.last_bucket = self.last_input; self.input_count = 0
        self.env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": self.directory.name}

    async def start(self):
        root = Path(self.directory.name); width, height = self.config["width"], self.config["height"]
        display = next((f":{i}" for i in range(100, 300) if not Path(f"/tmp/.X11-unix/X{i}").exists() and not Path(f"/tmp/.X{i}-lock").exists()), None)
        if not display: raise RuntimeError("No dedicated display is available")
        auth = str(root / "Xauthority")
        subprocess.run(["xauth", "-f", auth, "add", display, ".", secrets.token_hex(16)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=self.env)
        self.env.update(DISPLAY=display, XAUTHORITY=auth)
        xserver = subprocess.Popen(["Xvfb", display, "-auth", auth, "-nolisten", "tcp", "-screen", "0", f"{width}x{height}x24"], env=self.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.processes.append(xserver)
        for _ in range(50):
            if xserver.poll() is not None: raise RuntimeError("Dedicated display failed to start")
            if Path(f"/tmp/.X11-unix/X{display[1:]}").exists(): break
            await asyncio.sleep(.1)
        else: raise RuntimeError("Dedicated display timed out")
        box = ["bwrap", "--die-with-parent", "--unshare-all", "--new-session", "--clearenv", "--ro-bind", "/usr", "/usr", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/run", "--dir", "/home/player"]
        for directory in ("/lib", "/lib64", "/bin", "/sbin"):
            if Path(directory).exists(): box += ["--ro-bind", directory, directory]
        box += ["--ro-bind", f"/tmp/.X11-unix/X{display[1:]}", f"/tmp/.X11-unix/X{display[1:]}", "--ro-bind", auth, "/run/Xauthority", "--ro-bind", str(Path(self.game["directory"]).resolve()), "/game", "--chdir", "/game", "--setenv", "DISPLAY", display, "--setenv", "XAUTHORITY", "/run/Xauthority", "--setenv", "HOME", "/home/player", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "LANG", "C.UTF-8"]
        if self.game.get("network"):
            box += ["--share-net"]
            for file in ("/etc/resolv.conf", "/etc/hosts", "/etc/ssl/certs"):
                if Path(file).exists(): box += ["--ro-bind", file, file]
        audio = None
        if self.config.get("audio", True):
            pulse_socket = str(root / "pulse")
            pulse = subprocess.Popen(["pulseaudio", "-n", "--daemonize=no", "--exit-idle-time=-1", "--use-pid-file=no", "--load", f"module-native-protocol-unix socket={pulse_socket} auth-anonymous=1", "--load", "module-null-sink sink_name=game rate=48000 channels=2"], env=self.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.processes.append(pulse)
            for _ in range(50):
                if pulse.poll() is not None: raise RuntimeError("Isolated game audio failed to start")
                if Path(pulse_socket).exists(): break
                await asyncio.sleep(.1)
            else: raise RuntimeError("Isolated game audio timed out")
            self.env["PULSE_SERVER"] = "unix:" + pulse_socket
            box += ["--ro-bind", pulse_socket, "/run/pulse", "--setenv", "PULSE_SERVER", "unix:/run/pulse", "--setenv", "PULSE_SINK", "game"]
            capture = await asyncio.create_subprocess_exec("ffmpeg", "-nostdin", "-loglevel", "error", "-f", "pulse", "-i", "game.monitor", "-ar", "48000", "-ac", "2", "-f", "s16le", "pipe:1", env=self.env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
            self.async_processes.append(capture); audio = SoundTrack(capture.stdout)
        self.game_process = subprocess.Popen(box + ["--"] + self.game["command"], env=self.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.processes.append(self.game_process)
        capture = await asyncio.create_subprocess_exec("ffmpeg", "-nostdin", "-loglevel", "error", "-f", "x11grab", "-framerate", "30", "-video_size", f"{width}x{height}", "-i", display, "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1", env=self.env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        self.async_processes.append(capture)
        return FrameTrack(capture.stdout, width, height), audio

    def release(self):
        args = []
        for key in self.held: args += ["keyup", key]
        for button in self.buttons: args += ["mouseup", str(button)]
        if args: subprocess.run(["xdotool", *args], env=self.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1)
        self.held.clear(); self.buttons.clear()

    def input(self, data):
        now = time.monotonic()
        if now - self.last_bucket >= 1: self.last_bucket, self.input_count = now, 0
        self.input_count += 1
        if self.input_count > 120: return
        self.last_input = now
        if data.get("type") == "release": self.release(); return
        args = input_command(data, self.config["width"], self.config["height"])
        if not args: return
        if data["type"] == "key":
            if data["down"]: self.held.add(args[1])
            else: self.held.discard(args[1])
        if data["type"] == "pointer":
            mask = data.get("buttons", 0)
            if not isinstance(mask, int) or mask < 0 or mask > 7: return
            buttons = {button for bit, button in ((1, 1), (2, 3), (4, 2)) if mask & bit}
            for button in buttons - self.buttons: args += ["mousedown", str(button)]
            for button in self.buttons - buttons: args += ["mouseup", str(button)]
            self.buttons = buttons
        subprocess.run(["xdotool", *args], env=self.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1)

    async def close(self):
        with contextlib.suppress(Exception): self.release()
        for p in reversed(self.processes):
            if p.poll() is None: p.terminate()
        for p in self.async_processes:
            if p.returncode is None: p.terminate()
        for p in reversed(self.processes):
            try: await asyncio.to_thread(p.wait, timeout=3)
            except subprocess.TimeoutExpired: p.kill(); await asyncio.to_thread(p.wait)
        for p in self.async_processes:
            try: await asyncio.wait_for(p.communicate(), 3)
            except asyncio.TimeoutError: p.kill(); await p.communicate()
        self.directory.cleanup()

async def serve_session(portal, config, session, configuration):
    session_id = session["id"]; box = GameBox(config, session["game"])
    servers = [RTCIceServer(**s) for s in configuration.get("iceServers", [])]
    peer = RTCPeerConnection(RTCConfiguration(iceServers=servers)); ever_connected = False
    try:
        video, audio = await box.start(); peer.addTrack(video)
        if audio: peer.addTrack(audio)
        channel = peer.createDataChannel("input", ordered=True)
        @channel.on("message")
        def message(raw):
            if not isinstance(raw, str) or len(raw) > 1000: return
            try:
                data = json.loads(raw)
                if not isinstance(data, dict): return
                if data.get("type") == "ping" and isinstance(data.get("at"), (int, float)): channel.send(json.dumps({"type": "pong", "at": data["at"]}))
                else: box.input(data)
            except (ValueError, subprocess.SubprocessError): box.release()
        await portal.call("accept", id=session_id, accept=True)
        await peer.setLocalDescription(await peer.createOffer())
        await portal.call("signal", id=session_id, kind="offer", payload={"type": peer.localDescription.type, "sdp": peer.localDescription.sdp}, clientId=str(uuid.uuid4()))
        cursor = 0; candidates = []
        while box.game_process.poll() is None:
            connected = peer.connectionState == "connected"; ever_connected |= connected
            reply = await portal.call("poll", id=session_id, cursor=cursor, connected=connected)
            if reply["session"]["status"] not in ("requested", "connecting", "active"): break
            for entry in reply["signals"]:
                payload = entry["payload"]
                if entry["kind"] == "answer":
                    await peer.setRemoteDescription(RTCSessionDescription(sdp=payload["sdp"], type="answer"))
                    for candidate in candidates: await peer.addIceCandidate(candidate)
                    candidates.clear()
                elif entry["kind"] == "ice" and payload.get("candidate"):
                    candidate = candidate_from_sdp(payload["candidate"].removeprefix("candidate:"))
                    candidate.sdpMid, candidate.sdpMLineIndex = payload.get("sdpMid"), payload.get("sdpMLineIndex")
                    if peer.remoteDescription: await peer.addIceCandidate(candidate)
                    else: candidates.append(candidate)
                cursor = int(entry["id"])
            if time.monotonic() - box.last_input > 3: box.release()
            if peer.connectionState in ("failed", "closed"): break
            await asyncio.sleep(1.5)
    finally:
        await peer.close(); await box.close()
        with contextlib.suppress(Exception): await portal.call("finish", id=session_id, confirm=ever_connected)

async def run(config):
    token = os.environ.get("MV_HOST_KEY", "")
    if not token.startswith("mvh_"): raise RuntimeError("Set the scoped MV_HOST_KEY; never put it in config.json")
    for executable in ["ffmpeg", "Xvfb", "xauth", "xdotool", "bwrap"] + (["pulseaudio"] if config.get("audio", True) else []):
        if not shutil.which(executable): raise RuntimeError(f"Install required host component: {executable}")
    if os.geteuid() == 0: raise RuntimeError("Run as a dedicated non-root game-host account")
    if config.get("acceptSessions") is not True: raise RuntimeError("Set acceptSessions=true only after reviewing the configured games and isolation")
    portal = Portal(config["portal"], token)
    try:
        while True:
            reply = await portal.call("host.beat", online=True)
            for session in reply["sessions"]:
                if session["status"] != "requested":
                    await portal.call("finish", id=session["id"], confirm=False); continue
                if session["game"] not in config["games"]:
                    await portal.call("accept", id=session["id"], accept=False); continue
                try: await serve_session(portal, config, session, reply["configuration"])
                except Exception as error: print(f"Session stopped ({type(error).__name__}); host key was not logged.", flush=True)
            await asyncio.sleep(5)
    finally:
        with contextlib.suppress(Exception): await portal.call("host.beat", online=False)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="MAXIMUS dedicated Linux gaming host")
    parser.add_argument("--config", default="config.json"); args = parser.parse_args()
    config = validate_config(json.loads(Path(args.config).read_text()))
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try: asyncio.run(run(config))
    except KeyboardInterrupt: pass
