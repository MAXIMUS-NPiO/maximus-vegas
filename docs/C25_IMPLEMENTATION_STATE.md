# C-25 — Dedicated game-server implementation

MIPA internal implementation record. Continues the owner's instruction to implement the five supplied scientific works; C-24 is already deployed through PR #27. The dedicated-server portion remains unfinished and is being implemented here, without claiming that missing external infrastructure is operating.

Sources: `docs/FIVE_WORKS_IMPLEMENTATION.md`; owner-supplied `technical-en.pdf`, sections 6–7 (dedicated-server lifecycle, outbound agent and scoped credentials); existing `/server-rentals` direction (game, region, resources, schedule, backups and logs).

Acceptance scope: independently reviewed nodes and templates; real availability and bounded resource/port allocation; start/stop/restart/release; retained local backups with checked restore; private logs; scoped/revocable node keys; outbound-only control requests; lease expiry and loss-of-contact shutdown; replay and stale-revision protection; account export/erasure; RU/EN member/operator views; isolated domain, concurrency and browser checks. No executable, image, shell command or arbitrary filesystem path is accepted from a renting player.

No new paid infrastructure is provisioned. Paid server billing is not enabled without an approved service offer and payment configuration. A container image and game licence must be supplied and approved by the actual node operator. Real hardware, public game-port reachability and game compatibility require acceptance on the external node. Windows/macOS streaming agents, GPU fleet and chain/publisher connections remain separately tracked, not silently counted as complete.

Current state: task claimed; implementation in progress. The connected hosting account still cannot access the production team's settings (403 on 3 October 2026), while the protected GitHub publication pipeline works. No browser fallback or paid service was used to bypass that access boundary.
