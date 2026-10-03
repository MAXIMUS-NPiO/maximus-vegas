"""Local HTTP acceptance adapter; no container runtime and never a production origin."""
import json
import sys
from pathlib import Path
import tempfile
import time
from urllib.parse import urlsplit
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server-agent"))
from agent import Agent, Portal, atomic_json
from protocol import fingerprint, manifest
from test_agent import FakeBackend

control_path = Path(sys.argv[1]).resolve()
if "artifacts" not in control_path.parts:
    raise RuntimeError("ignored fixture directory required")
control = json.loads(control_path.read_text())
origin = urlsplit(control["portal"])
if origin.scheme != "http" or origin.hostname not in ("localhost", "127.0.0.1"):
    raise RuntimeError("local HTTP fixture only")
with tempfile.TemporaryDirectory(prefix="mv-rental-adapter-") as directory:
    config = dict(control["config"], dataDir=Path(directory), portal=control["portal"])
    template = manifest(control["template"])
    config["templates"] = {template["localKey"]: template}
    backend = FakeBackend()
    agent = Agent(config, backend, Portal(config, control["key"]))
    agent.templates = [fingerprint(template)]
    for step in range(2400):
        control = json.loads(control_path.read_text())
        agent.portal.token = control["key"]
        status = "connected"
        try:
            agent.cycle()
        except Exception as error:
            backend.stop_all()
            status = type(error).__name__
        atomic_json(control_path.with_name("c25-agent-status.json"), {"status": status, "steps": step, "starts": backend.starts, "backups": backend.exports, "restores": backend.imports, "volumes": len(backend.volumes), "running": sum(bool(c["State"]["Running"]) for c in backend.containers.values())})
        time.sleep(0.25)
    backend.stop_all()
