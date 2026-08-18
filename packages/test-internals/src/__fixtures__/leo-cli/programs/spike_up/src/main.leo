// Upgradeable package, final revision. `@admin` is devnode account 0, the key
// the spike signs with, so the happy-path upgrade is accepted.
//
// This file is where the package ended up, not where any one capture found it:
// transitions were added between runs on purpose, because that is what makes
// the upgrade and rebuild cases mean anything. `upgrade-save` was captured at
// `put`/`clear`, `deploy-rebuild-build-current` at `put`/`clear`/`probe`. See
// the revision table in ../../../README.md.
program spike_up.aleo {
    mapping slots: u32 => u32;

    @admin(address="aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px")
    constructor() {}

    fn put(public slot: u32, public v: u32) -> Final {
        return final {
            slots.set(slot, v);
        };
    }

    fn clear(public slot: u32) -> Final {
        return final {
            slots.set(slot, 0u32);
        };
    }

    fn probe(public slot: u32) -> Final {
        return final {
            slots.set(slot, 7u32);
        };
    }

    fn touch(public slot: u32) -> Final {
        return final {
            slots.set(slot, 9u32);
        };
    }
}
