"""Bounded control-plane messages and operator-only game manifests."""
import hashlib
import json
import math
import re
import tarfile
from datetime import datetime, timezone
from pathlib import PurePosixPath
from urllib.parse import urlsplit


class Invalid(ValueError):
    pass


def integer(value, low, high):
    if type(value) is not int or not low <= value <= high:
        raise Invalid("integer outside allowed range")
    return value


def uuid(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", value):
        raise Invalid("invalid identifier")
    return value


def digest(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
        raise Invalid("invalid fingerprint")
    return value


def text(value, limit):
    if not isinstance(value, str) or not value or len(value) > limit or any(ord(c) < 32 for c in value):
        raise Invalid("invalid text")
    return value


def manifest(raw):
    if not isinstance(raw, dict):
        raise Invalid("invalid template")
    key = text(raw.get("localKey"), 40)
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{1,39}", key):
        raise Invalid("invalid local key")
    image = text(raw.get("image"), 300)
    if not re.fullmatch(r"[a-z0-9.-]+(?::[0-9]+)?/[a-zA-Z0-9._/-]+@sha256:[0-9a-f]{64}", image):
        raise Invalid("image must be fully qualified and pinned by digest")
    command = raw.get("command")
    if not isinstance(command, list) or not 1 <= len(command) <= 40:
        raise Invalid("static argument vector required")
    command = [text(x, 1000) for x in command]
    ports = raw.get("ports")
    if not isinstance(ports, list) or not 1 <= len(ports) <= 8:
        raise Invalid("invalid ports")
    normalized_ports = []
    names, sockets = set(), set()
    for p in ports:
        name = text(p.get("name"), 40)
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{1,39}", name) or p.get("protocol") not in ("tcp", "udp"):
            raise Invalid("invalid port")
        port = integer(p.get("container"), 1024, 65535)
        socket = (port, p["protocol"])
        if name in names or socket in sockets:
            raise Invalid("duplicate port")
        names.add(name)
        sockets.add(socket)
        normalized_ports.append(dict(name=name, container=port, protocol=p["protocol"]))
    env, secrets = raw.get("env", {}), raw.get("secretEnv", {})
    for mapping in (env, secrets):
        if not isinstance(mapping, dict) or len(mapping) > 30:
            raise Invalid("invalid environment")
        for k, v in mapping.items():
            if not re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", k):
                raise Invalid("invalid environment name")
            text(v, 2000)
    if set(env) & set(secrets) or any(not re.fullmatch(r"MV_GAME_[A-Z0-9_]{1,56}", v) for v in secrets.values()):
        raise Invalid("secret values must refer to MV_GAME_ variables")
    return dict(localKey=key, name=text(raw.get("name"), 100), game=text(raw.get("game"), 40), image=image,
                command=command, cpuMillis=integer(raw.get("cpuMillis"), 250, 128000),
                memoryMb=integer(raw.get("memoryMb"), 256, 524288), diskMb=integer(raw.get("diskMb"), 256, 4194304),
                ports=normalized_ports, env=env, secretEnv=secrets)


def fingerprint(template):
    return hashlib.sha256(json.dumps(template, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def instant(value):
    try:
        date = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if not date.tzinfo:
            raise ValueError()
        return date.timestamp()
    except (ValueError, TypeError, AttributeError):
        raise Invalid("invalid time") from None


def portal_origin(value, allow_local=False):
    parts = urlsplit(value)
    if parts.username or parts.password or parts.query or parts.fragment or parts.path not in ("", "/"):
        raise Invalid("portal must be an origin without credentials or paths")
    if not parts.hostname or (parts.scheme != "https" and not (allow_local and parts.scheme == "http" and parts.hostname in ("localhost", "127.0.0.1"))):
        raise Invalid("HTTPS portal origin required")
    return value.rstrip("/")


def plan(raw, config, now):
    if not isinstance(raw, dict) or not isinstance(raw.get("node"), dict):
        raise Invalid("invalid plan")
    node = raw["node"]
    if uuid(node.get("id")) != config["nodeId"]:
        raise Invalid("node mismatch")
    for key in ("cpuMillis", "memoryMb", "storageMb", "portStart", "portEnd"):
        if node.get(key) != config[key]:
            raise Invalid("registered capacity differs from local configuration")
    integer(node.get("keyEpoch"), 1, 2147483647)
    if abs(instant(raw.get("serverTime")) - now) > 30:
        raise Invalid("clock is not synchronized")
    leases, jobs = raw.get("leases"), raw.get("jobs")
    if not isinstance(leases, list) or len(leases) > 16 or not isinstance(jobs, list) or len(jobs) > 16:
        raise Invalid("oversized plan")
    ids, ports, cpus, memory, disk = set(), set(), 0, 0, 0
    for lease in leases:
        identifier = uuid(lease.get("id"))
        if identifier in ids:
            raise Invalid("duplicate lease")
        ids.add(identifier)
        integer(lease.get("revision"), 1, 2147483647)
        if lease.get("desired") not in ("running", "stopped", "released"):
            raise Invalid("invalid desired state")
        start, end = instant(lease.get("startsAt")), instant(lease.get("expiresAt"))
        if not 0 < end - start <= 14400 or start - now > 86430:
            raise Invalid("invalid reservation window")
        # Cleanup still works after an operator removes or changes a template.
        if lease["desired"] == "released" or end <= now:
            continue
        template = config["templates"].get(lease.get("localKey"))
        if not template or digest(lease.get("fingerprint")) != fingerprint(template):
            raise Invalid("unapproved local manifest")
        for key in ("cpuMillis", "memoryMb", "diskMb"):
            if lease.get(key) != template[key]:
                raise Invalid("resource mismatch")
        cpus += template["cpuMillis"]
        memory += template["memoryMb"]
        disk += template["diskMb"] * 5
        if not isinstance(lease.get("ports"), list) or len(lease["ports"]) != len(template["ports"]):
            raise Invalid("port mismatch")
        for wanted, approved in zip(lease["ports"], template["ports"]):
            if any(wanted.get(k) != v for k, v in approved.items()):
                raise Invalid("port mismatch")
            host = integer(wanted.get("host"), config["portStart"], config["portEnd"])
            if host in ports:
                raise Invalid("host port already reserved")
            ports.add(host)
    if cpus > config["cpuMillis"] or memory > config["memoryMb"] or disk > config["storageMb"]:
        raise Invalid("node capacity exceeded")
    job_ids, busy = set(), set()
    for job in jobs:
        identifier, lease_id = uuid(job.get("id")), uuid(job.get("leaseId"))
        lease = next((l for l in leases if l["id"] == lease_id), None)
        if identifier in job_ids or lease_id in busy or not lease or lease["desired"] != "stopped" or job.get("revision") != lease["revision"]:
            raise Invalid("job does not match stopped lease")
        job_ids.add(identifier)
        busy.add(lease_id)
        if job.get("kind") not in ("backup", "restore"):
            raise Invalid("invalid job")
        if job["kind"] == "restore":
            uuid(job.get("backupId"))
            digest(job.get("digest"))
    return raw


def validate_archive(path, byte_limit):
    """Validate without extracting on the host; reject links, devices and escaping names."""
    if path.stat().st_size > byte_limit:
        raise Invalid("backup exceeds data budget")
    total, seen, count = 0, set(), 0
    with tarfile.open(path, "r:") as archive:
        for item in archive:
            count += 1
            name = PurePosixPath(item.name)
            if count > 100000 or len(item.name) > 1024 or name.is_absolute() or ".." in name.parts or "\\" in item.name:
                raise Invalid("unsafe archive path")
            if not (item.isfile() or item.isdir()) or item.mode & 0o7000 or item.size < 0 or item.sparse is not None:
                raise Invalid("unsafe archive entry")
            normalized = str(name)
            if normalized in seen:
                raise Invalid("duplicate archive path")
            seen.add(normalized)
            total += item.size
            if total > byte_limit:
                raise Invalid("expanded archive exceeds data budget")
    with path.open("rb") as source:
        checksum = hashlib.file_digest(source, "sha256").hexdigest()
    return checksum, path.stat().st_size


def clean_log(value, secrets=()):
    for secret in secrets:
        if secret:
            value = value.replace(secret, "[redacted]")
    value = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", value)
    value = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", value)
    value = re.sub(r"(?i)\b(Bearer\s+|(?:password|token|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+", r"\1[redacted]", value)
    return value.encode("utf-8")[-4000:].decode("utf-8", errors="ignore")
