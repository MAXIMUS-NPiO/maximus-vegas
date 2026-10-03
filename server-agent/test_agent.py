import copy
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch
from uuid import uuid4
from agent import Agent, Podman, Portal, child_environment, watchdog
from protocol import Invalid, clean_log, fingerprint, manifest, plan, portal_origin, validate_archive


def iso(t):
    from datetime import datetime, timezone
    return datetime.fromtimestamp(t, timezone.utc).isoformat()


def template():
    return manifest(dict(localKey="licensed-game", name="Isolated fixture", game="cs2", image="registry.example.org/game@sha256:" + "a" * 64,
                         command=["/game/server", "--data", "/data"], cpuMillis=1000, memoryMb=512, diskMb=1024,
                         ports=[dict(name="game", container=27015, protocol="udp")]))


class FakeBackend:
    def __init__(self):
        self.volumes, self.containers = {}, {}
        self.starts = self.exports = self.imports = self.kills = 0
        self.fail_import = False

    def volume(self, name, lease):
        self.volumes.setdefault(name, b"saved game")

    def usage(self, volume, limit):
        if len(self.volumes[volume]) > limit:
            raise Invalid("capacity exceeded")
        return len(self.volumes[volume])

    def start(self, lease, template, volume, seconds):
        self.starts += 1
        self.containers["mvgs-" + lease["id"]] = dict(State=dict(Running=True), Config=dict(Labels={"mvgs.revision": str(lease["revision"])}))

    def inspect(self, name):
        return self.containers.get(name)

    def stop(self, name):
        if name in self.containers:
            self.containers[name]["State"]["Running"] = False

    def stop_all(self):
        self.kills += 1
        for name in self.containers:
            self.stop(name)

    def remove(self, name):
        self.containers.pop(name, None)

    def cleanup(self, lease):
        self.remove("mvgs-" + lease)
        for name in list(self.volumes):
            if lease in name:
                del self.volumes[name]

    def logs(self, name):
        return "token=fixture-secret private-key-value 正常"

    def backup(self, volume, target, limit):
        self.exports += 1
        with tarfile.open(target, "w") as archive:
            item = tarfile.TarInfo("world.dat")
            item.size = len(self.volumes[volume])
            archive.addfile(item, io.BytesIO(self.volumes[volume]))

    def restore(self, volume, source):
        self.imports += 1
        if self.fail_import:
            raise Invalid("interrupted import")
        with tarfile.open(source) as archive:
            self.volumes[volume] = archive.extractfile("world.dat").read()

    def delete_volume(self, name):
        del self.volumes[name]


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.t = template()
        self.config = dict(nodeId=str(uuid4()), dataDir=self.root, cpuMillis=1000, memoryMb=1024, storageMb=5120, portStart=27015, portEnd=27015, templates={self.t["localKey"]: self.t})
        self.lease = dict(id=str(uuid4()), revision=1, desired="running", startsAt=iso(time.time() - 1), expiresAt=iso(time.time() + 1800), localKey=self.t["localKey"], fingerprint=fingerprint(self.t), cpuMillis=1000, memoryMb=512, diskMb=1024, ports=[dict(name="game", container=27015, protocol="udp", host=27015)])
        self.backend = FakeBackend()
        self.agent = Agent(self.config, self.backend, None)
        self.agent.secrets = ["private-key-value"]
        self.agent.last_contact = time.monotonic()

    def response(self, leases=None, jobs=None):
        node = {k: self.config[k] for k in ("cpuMillis", "memoryMb", "storageMb", "portStart", "portEnd")}
        return dict(serverTime=iso(time.time()), node=dict(node, id=self.config["nodeId"], keyEpoch=1), leases=leases if leases is not None else [copy.deepcopy(self.lease)], jobs=jobs or [])

    def apply(self, jobs=None):
        self.agent.apply(plan(self.response(jobs=jobs), self.config, time.time()), time.time())

    def stopped(self):
        self.apply()
        self.lease.update(desired="stopped", revision=2)
        self.apply()

    def backup(self):
        job = dict(id=str(uuid4()), leaseId=self.lease["id"], revision=2, kind="backup")
        self.apply([job])
        entry = self.agent.state["leases"][self.lease["id"]]
        return job, copy.deepcopy(entry["job"])

    def test_manifest_and_plan_reject_untrusted_commands_capacity_clock_and_ports(self):
        changed = copy.deepcopy(self.t)
        changed["command"].append("--different")
        self.assertNotEqual(fingerprint(self.t), fingerprint(changed))
        for modify in (lambda p: p["leases"][0].update(fingerprint="b" * 64), lambda p: p["leases"][0].update(memoryMb=2), lambda p: p["leases"][0]["ports"][0].update(host=22), lambda p: p.update(serverTime=iso(time.time() - 90)), lambda p: p["node"].update(id=str(uuid4()))):
            p = self.response()
            modify(p)
            with self.assertRaises(Invalid):
                plan(p, self.config, time.time())
        with self.assertRaises(Invalid):
            manifest(dict(self.t, image="game:latest"))
        with self.assertRaises(Invalid):
            manifest(dict(self.t, secretEnv={"KEY": "MV_RENTAL_NODE_KEY"}))

    def test_origin_rejects_redirect_targets_credentials_and_nonlocal_http(self):
        for value in ("http://example.org", "https://user:secret@example.org", "https://example.org/path", "https://example.org?key=x", "file:///tmp/x"):
            with self.assertRaises(Invalid):
                portal_origin(value, True)
        self.assertEqual(portal_origin("http://127.0.0.1:3100", True), "http://127.0.0.1:3100")
        with self.assertRaises(Invalid):
            portal_origin("http://127.0.0.1:3100")

    def test_start_is_idempotent_restart_uses_revision_and_stale_plan_fails(self):
        self.apply()
        self.apply()
        self.assertEqual(self.backend.starts, 1)
        self.lease["revision"] = 2
        self.apply()
        self.assertEqual(self.backend.starts, 2)
        self.lease["revision"] = 1
        with self.assertRaises(Invalid):
            self.apply()
        self.assertNotIn("fixture-secret", self.agent.reports()[0]["logs"])
        self.assertNotIn("private-key-value", self.agent.reports()[0]["logs"])

    def test_scheduled_start_and_lost_contact_do_not_launch(self):
        self.lease["startsAt"] = iso(time.time() + 600)
        self.apply()
        self.assertEqual(self.backend.starts, 0)
        self.lease["startsAt"] = iso(time.time() - 1)
        self.agent.last_contact = time.monotonic() - 60
        self.apply()
        self.assertEqual(self.backend.starts, 0)
        self.assertEqual(self.agent.reports()[0]["status"], "error")

    def test_expiry_and_release_remove_data_and_backups_then_report_cleanup(self):
        self.stopped()
        job, _ = self.backup()
        self.assertTrue(self.agent.backup_path(self.lease["id"], job["id"]).exists())
        self.lease.update(desired="released", revision=3)
        self.apply()
        self.assertTrue(self.agent.reports()[0]["cleaned"])
        self.assertFalse(self.backend.volumes)
        self.assertFalse(list(self.root.glob("*.tar")))
        self.agent.apply(self.response(leases=[]), time.time())
        self.assertEqual(self.agent.reports(), [])

    def test_local_expiry_cleans_up_without_portal_contact(self):
        self.apply()
        self.agent.expire(time.time() + 1900)
        self.assertTrue(self.agent.reports()[0]["cleaned"])
        self.assertFalse(self.backend.containers)

    def test_backup_replay_restore_switch_and_recovery_from_saved_state(self):
        self.stopped()
        job, receipt = self.backup()
        self.apply([job])
        self.assertEqual(self.backend.exports, 1)
        entry = self.agent.state["leases"][self.lease["id"]]
        old = entry["volume"]
        self.backend.volumes[old] = b"new game"
        restore = dict(id=str(uuid4()), leaseId=self.lease["id"], revision=2, kind="restore", backupId=job["id"], digest=receipt["digest"])
        self.apply([restore])
        self.assertNotIn(old, self.backend.volumes)
        self.assertEqual(self.backend.volumes[entry["volume"]], b"saved game")
        self.agent = Agent(self.config, self.backend, None)
        self.agent.last_contact = time.monotonic()
        self.apply([restore])
        self.assertEqual(self.backend.imports, 1)
        self.assertEqual(self.agent.reports()[0]["job"]["status"], "succeeded")

    def test_corrupt_backup_and_failed_restore_preserve_current_volume(self):
        self.stopped()
        job, receipt = self.backup()
        entry = self.agent.state["leases"][self.lease["id"]]
        old = entry["volume"]
        self.backend.fail_import = True
        restore = dict(id=str(uuid4()), leaseId=self.lease["id"], revision=2, kind="restore", backupId=job["id"], digest=receipt["digest"])
        self.apply([restore])
        self.assertEqual(entry["volume"], old)
        self.assertEqual(list(self.backend.volumes), [old])
        self.assertEqual(self.agent.reports()[0]["job"]["status"], "failed")
        self.backend.fail_import = False
        restore.update(id=str(uuid4()), digest="0" * 64)
        self.apply([restore])
        self.assertEqual(entry["volume"], old)
        self.assertEqual(self.backend.imports, 1)

    def test_backup_archives_reject_traversal_links_devices_and_oversize(self):
        for name, kind in (("../escape", tarfile.REGTYPE), ("/absolute", tarfile.REGTYPE), ("link", tarfile.SYMTYPE), ("hard", tarfile.LNKTYPE), ("device", tarfile.CHRTYPE)):
            path = self.root / "invalid.tar"
            with tarfile.open(path, "w") as archive:
                item = tarfile.TarInfo(name)
                item.type, item.linkname = kind, "target"
                archive.addfile(item)
            with self.assertRaises(Invalid):
                validate_archive(path, 1048576)
        with self.assertRaises(Invalid):
            validate_archive(path, 100)

    def test_game_crash_does_not_trigger_unbounded_automatic_restarts(self):
        self.apply()
        self.backend.stop("mvgs-" + self.lease["id"])
        self.apply()
        self.apply()
        self.assertEqual(self.backend.starts, 1)
        self.assertEqual(self.agent.reports()[0]["status"], "error")

    def test_utf8_log_budget_and_child_environment_hide_secrets(self):
        self.assertLessEqual(len(clean_log("界" * 5000).encode()), 4000)
        with patch.dict(os.environ, {"MV_RENTAL_NODE_KEY": "hidden", "MV_GAME_LOGIN": "hidden-too"}):
            self.assertNotIn("MV_RENTAL_NODE_KEY", child_environment())
            self.assertNotIn("MV_GAME_LOGIN", child_environment())

    def test_watchdog_kills_on_parent_exit_and_on_stale_contact(self):
        with patch("agent.Podman", return_value=self.backend), patch("agent.os.kill", side_effect=ProcessLookupError):
            watchdog(self.config, 12345)
        self.assertEqual(self.backend.kills, 1)
        (self.root / "contact.json").write_text(json.dumps({"pid": 12345, "at": time.time() - 100}))
        with patch("agent.Podman", return_value=self.backend), patch("agent.os.kill"), patch("agent.time.monotonic", side_effect=[0, 41]), patch("agent.time.sleep", side_effect=RuntimeError("stop fixture loop")):
            with self.assertRaisesRegex(RuntimeError, "stop fixture loop"):
                watchdog(self.config, 12345)
        self.assertEqual(self.backend.kills, 2)

    def test_http_redirect_never_forwards_node_credentials(self):
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def do_POST(inner):
                requests.append(inner.path)
                inner.send_response(307)
                inner.send_header("Location", "/credential-trap")
                inner.end_headers()
            def log_message(*_):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            portal = Portal({"portal": f"http://127.0.0.1:{server.server_port}"}, "mvr_" + "x" * 43)
            with self.assertRaises(Invalid):
                portal.sync([], [], False)
            self.assertEqual(requests, ["/api/rentals/agent"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_container_arguments_are_isolated_pinned_and_secrets_not_in_argv(self):
        backend = object.__new__(Podman)
        backend.config = self.config
        backend.remove = lambda _: None
        captured = []
        def run(args):
            env_path = Path(args[args.index("--env-file") + 1])
            self.assertEqual(env_path.stat().st_mode & 0o777, 0o600)
            self.assertIn("password-value", env_path.read_text())
            captured.append(args)
        backend.run = run
        t = dict(self.t, secretEnv={"SERVER_PASSWORD": "MV_GAME_SERVER_PASSWORD"})
        with patch.dict(os.environ, {"MV_GAME_SERVER_PASSWORD": "password-value"}):
            backend.start(self.lease, t, "named-volume", 600)
        args = captured[0]
        self.assertNotIn("password-value", " ".join(args))
        self.assertIn("--pull=never", args)
        self.assertIn("--read-only", args)
        self.assertIn("--cap-drop=ALL", args)
        self.assertIn("--network=slirp4netns:allow_host_loopback=false", args)
        self.assertEqual(args[args.index("--timeout") + 1], "600")
        self.assertFalse(list(self.root.glob(".game-env-*")))


if __name__ == "__main__":
    unittest.main()
