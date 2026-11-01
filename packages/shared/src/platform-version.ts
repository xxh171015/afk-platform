import root from "../../../package.json" with { type: "json" };

// The one place the platform's version is read: the root package.json (no package of the workspace has its own).
// `plat tracker-doc` writes it on the first line of the tracker doc. Raise it by hand when the platform changes in a
// way a person who planned with an older one should hear about; the doc itself is compared whole, so a version bump
// is a label, not what makes it stale.
export const PLATFORM_VERSION: string = root.version;
