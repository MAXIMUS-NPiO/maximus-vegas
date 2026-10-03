#!/usr/bin/env python3
"""Outbound dedicated-game-server agent. Requires Linux, rootless Podman and a bounded data filesystem."""
import argparse
import atexit
import fcntl
import json
import math
import os
from pathlib import Path
import resource
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from protocol import Invalid, clean_log, digest, fingerprint, instant, integer, manifest, plan, portal_origin, uuid, validate_archive

CONTACT_SECONDS = 40


def atomic_json(path, value):
    fd, temp = tempfile.mkstemp(prefix=".write-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as out:
            os.fchmod(out.fileno(), 0o600)
            json.dump(value, out, separators=(",", ":"))
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, path)
        parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        Path(temp).unlink(missing_ok=True)


def child_environment():
    # The node key and game secrets must never reach Podman or the watchdog.
    return {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "DBUS_SESSION_BUS_ADDRESS", "LANG", "LC_ALL", "TMPDIR")}


def configuration(path, allow_local=False):
    with open(path) as source:
        raw = json.load(source)
    raw["portal"] = portal_origin(raw.get("portal", ""), allow_local)
    uuid(raw.get("nodeId"))
    for key, low, high in (("cpuMillis", 1000, 256000), ("memoryMb", 512, 1048576), ("storageMb", 1024, 16777216), ("portStart", 1024, 65000), ("portEnd", 1024, 65535)):
        integer(raw.get(key), low, high)
    if not raw["portStart"] <= raw["portEnd"] <= raw["portStart"] + 511:
        raise Invalid("invalid node port range")
    data = Path(raw.get("dataDir", ""))
    if not data.is_absolute():
        raise Invalid("absolute operator dataDir required")
    raw["dataDir"] = data.resolve()
    templates = raw.get("templates")
    if not isinstance(templates, list) or not 1 <= len(templates) <= 30:
        raise Invalid("one to thirty local templates required")
    raw["templates"] = {}
    for entry in templates:
        template = manifest(entry)
        if template["localKey"] in raw["templates"] or template["cpuMillis"] > raw["cpuMillis"] or template["memoryMb"] > raw["memoryMb"] or template["diskMb"] * 5 > raw["storageMb"] or len(template["ports"]) > raw["portEnd"] - raw["portStart"] + 1:
            raise Invalid("template exceeds node capacity or repeats a key")
        raw["templates"][template["localKey"]] = template
    return raw


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Invalid("control endpoint redirects are not permitted")


class Portal:
    def __init__(self, config, token):
        self.url = config["portal"] + "/api/rentals/agent"
        if not isinstance(token, str) or len(token) != 47 or not token.startswith("mvr_"):
            raise Invalid("MV_RENTAL_NODE_KEY is missing or invalid")
        self.token = token
        self.http = urllib.request.build_opener(NoRedirect())

    def sync(self, reports, templates, ready):
        body = json.dumps(dict(reports=reports, templates=templates, ready=ready), separators=(",", ":"), ensure_ascii=False).encode()
        if len(body) > 100000:
            raise Invalid("report exceeds request budget")
        request = urllib.request.Request(self.url, data=body, method="POST", headers={"Content-Type": "application/json", "Authorization": "Bearer " + self.token})
        with self.http.open(request, timeout=10) as response:
            data = response.read(2000001)
            if len(data) > 2000000 or response.status != 200:
                raise Invalid("invalid control response")
            return json.loads(data)


class Podman:
    def __init__(self, config):
        self.config = config
        self.binary = shutil.which("podman")
        if not self.binary:
            raise Invalid("Podman is not installed")
        self.env = child_environment()

    def run(self, args, timeout=20, check=True, file_limit=None):
        def limits():
            resource.setrlimit(resource.RLIMIT_FSIZE, (file_limit, file_limit))
        result = subprocess.run([self.binary, *args], env=self.env, stdin=subprocess.DEVNULL,
                                capture_output=True, timeout=timeout, check=False,
                                preexec_fn=limits if file_limit else None)
        if check and result.returncode:
            # CLI errors can contain environment values. Never send them to the portal.
            raise Invalid("container operation failed; inspect the local service")
        if len(result.stdout) > 4000000:
            raise Invalid("container response exceeded budget")
        return result

    def json(self, args):
        return json.loads(self.run(args).stdout)

    def preflight(self):
        if sys.platform != "linux" or os.geteuid() == 0:
            raise Invalid("a dedicated unprivileged Linux account is required")
        info = self.json(["info", "--format=json"])
        host = info.get("host", {})
        if not host.get("security", {}).get("rootless") or host.get("cgroupVersion") != "v2" or not {"cpu", "memory", "pids"} <= set(host.get("cgroupControllers", [])):
            raise Invalid("rootless Podman with delegated CPU, memory and pids cgroup v2 controllers is required")
        volume_path = Path(info.get("store", {}).get("volumePath", ""))
        data = self.config["dataDir"]
        if not volume_path.is_absolute() or not volume_path.is_dir() or data.stat().st_dev != volume_path.stat().st_dev:
            raise Invalid("Podman volume_path and agent dataDir must share the dedicated bounded filesystem")
        if data.stat().st_uid != os.getuid() or volume_path.stat().st_uid != os.getuid():
            raise Invalid("storage must belong to the dedicated service account")
        size = os.statvfs(volume_path)
        if size.f_blocks * size.f_frsize > self.config["storageMb"] * 1048576:
            raise Invalid("data filesystem is larger than the registered node storage budget")
        if self.config["cpuMillis"] > (os.cpu_count() or 1) * 1000 or self.config["memoryMb"] * 1048576 > os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES"):
            raise Invalid("registered capacity exceeds this machine")
        # Probe a real named volume: its data cannot silently use a different disk.
        probe = f"mvgs-probe-{self.config['nodeId']}"
        self.volume(probe, "probe")
        try:
            if Path(self.volume_path(probe)).stat().st_dev != data.stat().st_dev:
                raise Invalid("named volumes do not use the bounded filesystem")
        finally:
            self.run(["volume", "rm", probe], check=False)
        available = []
        for template in self.config["templates"].values():
            if self.run(["image", "exists", template["image"]], check=False).returncode == 0:
                if all(os.environ.get(name) for name in template["secretEnv"].values()):
                    available.append(fingerprint(template))
        return available

    def volume(self, name, lease_id):
        if self.run(["volume", "exists", name], check=False).returncode:
            self.run(["volume", "create", "--label", f"mvgs.node={self.config['nodeId']}", "--label", f"mvgs.lease={lease_id}", name])
        else:
            labels = self.json(["volume", "inspect", name])[0].get("Labels", {}) or {}
            if labels.get("mvgs.node") != self.config["nodeId"] or labels.get("mvgs.lease") != lease_id:
                raise Invalid("volume is owned by another workload")

    def volume_path(self, name):
        return self.json(["volume", "inspect", name])[0]["Mountpoint"]

    def inspect(self, name):
        result = self.run(["container", "inspect", name], check=False)
        if result.returncode:
            return None
        item = json.loads(result.stdout)[0]
        if item.get("Config", {}).get("Labels", {}).get("mvgs.node") != self.config["nodeId"]:
            raise Invalid("container is owned by another workload")
        return item

    def stop(self, name):
        if self.inspect(name):
            self.run(["stop", "--time", "3", name], timeout=10)

    def remove(self, name):
        if self.inspect(name):
            self.run(["rm", "--force", name], timeout=15)

    def stop_all(self):
        names = self.run(["ps", "--all", "--filter", f"label=mvgs.node={self.config['nodeId']}", "--format", "{{.Names}}"], check=False).stdout.decode().split()
        if names:
            # Stop together instead of multiplying the grace period by the number of leases.
            self.run(["kill", *names], timeout=20, check=False)

    def start(self, lease, template, volume, seconds):
        name = "mvgs-" + lease["id"]
        self.remove(name)
        args = ["run", "--detach", "--pull=never", "--name", name, "--label", f"mvgs.node={self.config['nodeId']}",
                "--label", f"mvgs.lease={lease['id']}", "--label", f"mvgs.revision={lease['revision']}",
                "--cpus", str(template["cpuMillis"] / 1000), "--memory", f"{template['memoryMb']}m", "--memory-swap", f"{template['memoryMb']}m",
                "--pids-limit", "256", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--read-only",
                "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m", "--tmpfs", "/run:rw,noexec,nosuid,nodev,size=16m",
                "--userns=keep-id:uid=1000,gid=1000", "--user", "1000:1000", "--volume", f"{volume}:/data:Z",
                "--workdir", "/data", "--network=slirp4netns:allow_host_loopback=false", "--log-driver=k8s-file", "--log-opt", "max-size=2mb",
                "--stop-timeout", "3", "--timeout", str(max(1, math.floor(seconds)))]
        for port in lease["ports"]:
            args.extend(["--publish", f"{port['host']}:{port['container']}/{port['protocol']}"])
        env = dict(template["env"])
        for key, source in template["secretEnv"].items():
            value = os.environ.get(source)
            if not value or "\n" in value or "\r" in value or "\x00" in value:
                raise Invalid("game secret is unavailable or invalid")
            env[key] = value
        fd, env_path = tempfile.mkstemp(prefix=".game-env-", dir=self.config["dataDir"])
        try:
            with os.fdopen(fd, "w") as output:
                os.fchmod(output.fileno(), 0o600)
                for key, value in env.items():
                    output.write(f"{key}={value}\n")
            args.extend(["--env-file", env_path, "--entrypoint", template["command"][0], template["image"], *template["command"][1:]])
            self.run(args)
        finally:
            Path(env_path).unlink(missing_ok=True)

    def logs(self, name):
        return self.run(["logs", "--tail", "80", name], check=False).stdout.decode(errors="replace")

    def usage(self, volume, limit):
        total, count = 0, 0
        for root, _, files in os.walk(self.volume_path(volume), followlinks=False):
            for name in files:
                item = os.lstat(Path(root) / name)
                total += item.st_size
                count += 1
                if total > limit or count > 100000:
                    raise Invalid("game data exceeded its monitored budget")
        return total

    def delete_volume(self, name):
        self.run(["volume", "rm", "--force", name])

    def cleanup(self, lease_id):
        self.remove("mvgs-" + lease_id)
        names = self.run(["volume", "ls", "--filter", f"label=mvgs.node={self.config['nodeId']}", "--filter", f"label=mvgs.lease={lease_id}", "--format", "{{.Name}}" ]).stdout.decode().split()
        for name in names:
            self.delete_volume(name)

    def backup(self, volume, target, limit):
        self.run(["volume", "export", "--output", str(target), volume], timeout=120, file_limit=limit)

    def restore(self, volume, source):
        self.run(["volume", "import", volume, str(source)], timeout=120)


class Agent:
    def __init__(self, config, backend, portal):
        self.config, self.backend, self.portal = config, backend, portal
        self.root = config["dataDir"]
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.root.stat().st_uid != os.getuid() or self.root.stat().st_mode & 0o077:
            raise Invalid("dataDir must be owned by this account with mode 0700")
        self.state_path = self.root / "state.json"
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else dict(nodeId=config["nodeId"], leases={})
        if self.state.get("nodeId") != config["nodeId"]:
            raise Invalid("state belongs to another node")
        self.last_contact = 0
        self.templates = []
        self.secrets = [os.environ.get("MV_RENTAL_NODE_KEY", "")]
        self.secrets += [os.environ.get(v, "") for t in config["templates"].values() for v in t["secretEnv"].values()]

    def save(self):
        atomic_json(self.state_path, self.state)

    def backup_path(self, lease_id, backup_id):
        return self.root / f"{uuid(lease_id)}-{uuid(backup_id)}.tar"

    def release(self, entry):
        self.backend.cleanup(entry["id"])
        for path in self.root.glob(entry["id"] + "-*"):
            if path.is_file() or path.is_symlink():
                path.unlink()
        entry.update(status="stopped", cleaned=True, logs="", note="", receipts={})
        self.save()

    def expire(self, now):
        for entry in self.state["leases"].values():
            if not entry.get("cleaned") and entry.get("expiresLocalAt", instant(entry["expiresAt"])) <= now:
                try:
                    self.release(entry)
                except Exception:
                    self.backend.stop_all()

    def reports(self):
        return [dict(id=e["id"], revision=e["revision"], status=e.get("status", "stopped"), cleaned=e.get("cleaned", False),
                     logs=clean_log(e.get("logs", ""), self.secrets), note=e.get("note", ""),
                     **({"job": e["job"]} if e.get("job") else {})) for e in self.state["leases"].values()]

    def job(self, job, entry):
        identifier = job["id"]
        receipts = entry.setdefault("receipts", {})
        if identifier in receipts:
            entry["job"] = receipts[identifier]
            return
        receipt = dict(id=identifier, status="failed", note="Local backup operation failed")
        try:
            if entry["status"] != "stopped" or entry.get("cleaned"):
                raise Invalid("backup requires a stopped allocated server")
            if job["kind"] == "backup":
                target = self.backup_path(entry["id"], identifier)
                if not target.exists():
                    if len(list(self.root.glob(entry["id"] + "-*.tar"))) >= 3:
                        raise Invalid("local backup limit reached")
                    temp = target.with_suffix(".partial")
                    try:
                        self.backend.backup(entry["volume"], temp, entry["diskMb"] * 1048576)
                        validate_archive(temp, entry["diskMb"] * 1048576)
                        temp.chmod(0o600)
                        os.replace(temp, target)
                    finally:
                        temp.unlink(missing_ok=True)
                checksum, size = validate_archive(target, entry["diskMb"] * 1048576)
                receipt = dict(id=identifier, status="succeeded", digest=checksum, bytes=size)
            else:
                source = self.backup_path(entry["id"], job["backupId"])
                checksum, _ = validate_archive(source, entry["diskMb"] * 1048576)
                if checksum != job["digest"]:
                    raise Invalid("backup digest mismatch")
                new_volume = f"mvgs-{entry['id']}-r-{identifier}"
                old_volume = entry["volume"]
                self.backend.volume(new_volume, entry["id"])
                try:
                    self.backend.restore(new_volume, source)
                except Exception:
                    self.backend.delete_volume(new_volume)
                    raise
                entry["volume"] = new_volume
                receipt = dict(id=identifier, status="succeeded")
                # Persist the switch and receipt before removing the old data. Replays never restore twice.
                receipts[identifier] = receipt
                entry["job"] = receipt
                self.save()
                self.backend.remove("mvgs-" + entry["id"])
                self.backend.delete_volume(old_volume)
        except Exception:
            pass
        receipts[identifier] = receipt
        entry["job"] = receipt
        self.save()

    def apply(self, response, now):
        desired_ids = {l["id"] for l in response["leases"]}
        for identifier in list(self.state["leases"]):
            if identifier not in desired_ids:
                self.release(self.state["leases"][identifier])
                del self.state["leases"][identifier]
        for lease in response["leases"]:
            identifier = lease["id"]
            entry = self.state["leases"].get(identifier)
            if entry and lease["revision"] < entry["revision"]:
                raise Invalid("stale command revision")
            if not entry:
                entry = {**lease, "volume": f"mvgs-{identifier}-data", "status": "stopped", "receipts": {}}
                self.state["leases"][identifier] = entry
            elif lease["revision"] != entry["revision"]:
                entry.pop("job", None)
                entry.pop("failedRevision", None)
            entry.update(lease)
            entry["expiresLocalAt"] = time.time() + instant(lease["expiresAt"]) - now
            self.save()
            try:
                if lease["desired"] == "released" or instant(lease["expiresAt"]) <= now:
                    if not entry.get("cleaned"):
                        self.release(entry)
                    continue
                if entry.get("cleaned"):
                    raise Invalid("a cleaned lease cannot be restarted")
                template = self.config["templates"][lease["localKey"]]
                name = "mvgs-" + identifier
                self.backend.volume(entry["volume"], identifier)
                self.backend.usage(entry["volume"], lease["diskMb"] * 1048576)
                if lease["desired"] == "stopped" or instant(lease["startsAt"]) > now:
                    self.backend.stop(name)
                    entry.update(status="stopped", note="Scheduled start is pending" if lease["desired"] != "stopped" else "")
                elif entry.get("failedRevision") == lease["revision"]:
                    continue
                else:
                    container = self.backend.inspect(name)
                    revision = container.get("Config", {}).get("Labels", {}).get("mvgs.revision") if container else None
                    running = container and container.get("State", {}).get("Running")
                    if container and not running and revision == str(lease["revision"]) and entry["status"] == "running":
                        raise Invalid("game process exited; explicit restart required")
                    if not running or revision != str(lease["revision"]):
                        if time.monotonic() - self.last_contact > 25:
                            raise Invalid("fresh control contact required before startup")
                        self.backend.start(lease, template, entry["volume"], instant(lease["expiresAt"]) - now - (time.monotonic() - self.last_contact))
                        container = self.backend.inspect(name)
                        running = container and container.get("State", {}).get("Running")
                    if not running:
                        raise Invalid("game process exited; inspect logs before restarting")
                    entry.update(status="running", note="")
                entry["logs"] = clean_log(self.backend.logs(name), self.secrets)
            except Exception:
                try:
                    self.backend.stop("mvgs-" + identifier)
                except Exception:
                    self.backend.stop_all()
                entry.update(status="error", note="Node could not apply this revision; check local configuration and restart", failedRevision=lease["revision"])
            self.save()
        for job in response["jobs"]:
            self.job(job, self.state["leases"][job["leaseId"]])
        self.save()

    def cycle(self):
        self.expire(time.time())
        response = plan(self.portal.sync(self.reports(), self.templates, bool(self.templates)), self.config, time.time())
        # Authenticated node/capacity/clock validation precedes watchdog renewal.
        self.last_contact = time.monotonic()
        atomic_json(self.root / "contact.json", {"at": time.time(), "pid": os.getpid()})
        self.apply(response, instant(response["serverTime"]))


def watchdog(config, parent=None):
    backend = Podman(config)
    path = config["dataDir"] / "contact.json"
    last_version, last_seen = None, 0.0
    while True:
        alive = True
        if parent:
            try:
                os.kill(parent, 0)
            except ProcessLookupError:
                alive = False
        try:
            state = json.loads(path.read_text())
            current = (state.get("pid"), state.get("at"))
            if current != last_version and state.get("pid") == parent and abs(time.time() - float(state["at"])) < CONTACT_SECONDS:
                last_version, last_seen = current, time.monotonic()
        except (OSError, ValueError, TypeError):
            pass
        if not alive or time.monotonic() - last_seen > CONTACT_SECONDS:
            try:
                backend.stop_all()
            except Exception:
                pass
        if not alive:
            return
        time.sleep(2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--describe", action="store_true")
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument("--stop-all", action="store_true")
    parser.add_argument("--watchdog", type=int)
    parser.add_argument("--allow-local-test", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    config = configuration(args.config, args.allow_local_test)
    if args.describe:
        for template in config["templates"].values():
            print(json.dumps({k: template[k] for k in ("localKey", "name", "game", "cpuMillis", "memoryMb", "diskMb", "ports")} | {"fingerprint": fingerprint(template)}, ensure_ascii=False))
        return
    if args.watchdog:
        watchdog(config, args.watchdog)
        return
    backend = Podman(config)
    if args.stop_all:
        backend.stop_all()
        return
    config["dataDir"].mkdir(parents=True, exist_ok=True, mode=0o700)
    # One process owns the node state; a second copy must not stop the first copy's servers.
    with (config["dataDir"] / "agent.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        backend.stop_all()
        available = backend.preflight()
        if args.preflight:
            print(json.dumps({"readyTemplates": available, "nodeId": config["nodeId"]}))
            return
        agent = Agent(config, backend, Portal(config, os.environ.get("MV_RENTAL_NODE_KEY")))
        agent.templates = available
        for stale in config["dataDir"].glob(".game-env-*"):
            if stale.is_file() or stale.is_symlink():
                stale.unlink()
        # A separate process enforces loss-of-contact shutdown during a long backup or stalled operation.
        guard = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--config", str(Path(args.config).resolve()), "--watchdog", str(os.getpid()), *(["--allow-local-test"] if args.allow_local_test else [])], env=child_environment(), stdin=subprocess.DEVNULL)
        def shutdown(*_):
            try:
                backend.stop_all()
            finally:
                guard.terminate()
            raise SystemExit(0)
        signal.signal(signal.SIGTERM, shutdown)
        signal.signal(signal.SIGINT, shutdown)
        atexit.register(backend.stop_all)
        last_check = time.monotonic()
        while True:
            try:
                if guard.poll() is not None:
                    raise Invalid("watchdog exited")
                if time.monotonic() - last_check > 60:
                    agent.templates = backend.preflight()
                    last_check = time.monotonic()
                if shutil.disk_usage(config["dataDir"]).free < 64 * 1048576:
                    raise Invalid("data filesystem is full")
                agent.cycle()
            except Exception as error:
                backend.stop_all()
                for entry in agent.state["leases"].values():
                    if not entry.get("cleaned"):
                        entry.update(status="stopped", logs="", note="Stopped while control contact is unavailable")
                agent.save()
                # Only exception class is emitted: HTTP URLs, key and CLI details are private.
                print(f"Control cycle stopped: {type(error).__name__}", file=sys.stderr, flush=True)
                if guard.poll() is not None:
                    raise SystemExit(1)
            time.sleep(5)


if __name__ == "__main__":
    try:
        main()
    except (Invalid, BlockingIOError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
