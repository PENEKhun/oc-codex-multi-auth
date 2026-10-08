import { describe, expect, it } from "vitest";
import { RotationObservations } from "../lib/custom-rotation/observations.js";
import type { AccountMetadataV3 } from "../lib/storage.js";

const account: AccountMetadataV3 = { accountId: "business", accountUserId: "seat-a", refreshToken: "synthetic", addedAt: 1, lastUsed: 2 };
describe("custom rotation observations", () => {
	it("preserves unknown values when no observation has arrived", () => {
		const store = new RotationObservations();
		const result = store.snapshot(account, "project", 1000);
		expect(result.primary.usedPercent).toMatchObject({ status: "unknown", value: null, observedAt: null });
	});
	it("marks observed quota stale when its freshness expires", () => {
		const store = new RotationObservations();
		store.usage(account, "project", { rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: 500 } } }, 1000);
		const result = store.snapshot(account, "project", 301_000);
		expect(result.primary.usedPercent).toMatchObject({ status: "stale", value: 20, scope: "seat", observedAt: 1000 });
	});
	it("marks disabled quota not-applicable when the plan reports a zero window", () => {
		const store = new RotationObservations();
		store.usage(account, "project", { rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 0 } } }, 1000);
		const result = store.snapshot(account, "project", 1000);
		expect(result.primary.usedPercent).toMatchObject({ status: "not-applicable", value: null });
	});
	it("keeps newer header fields when older background usage finishes later", () => {
		const store = new RotationObservations();
		store.headers(account, "project", new Headers({ "x-codex-primary-used-percent": "90" }), 2000);
		store.usage(account, "project", { rate_limit: { primary_window: { used_percent: 10, reset_at: 500 } } }, 1000);
		const result = store.snapshot(account, "project", 2000);
		expect(result.primary.usedPercent).toMatchObject({ value: 90, source: "headers", observedAt: 2000 });
		expect(result.primary.resetAtMs.value).toBe(500_000);
	});
	it("preserves string credit balances when they exceed numeric precision", () => {
		const store = new RotationObservations();
		store.usage(account, "project", { credits: { balance: "999999999999999999.125", unlimited: false } }, 1000);
		const result = store.snapshot(account, "project", 1000);
		expect(result.credits.value).toEqual({ balance: "999999999999999999.125", unlimited: false });
	});
	it("keeps unlimited distinct from unknown balance when credits report it", () => {
		const store = new RotationObservations();
		store.usage(account, "project", { credits: { unlimited: true, balance: null } }, 1000);
		const result = store.snapshot(account, "project", 1000);
		expect(result.credits.value).toEqual({ balance: null, unlimited: true });
	});
	it("separates observations when Business seats share a workspace", () => {
		const store = new RotationObservations();
		store.usage(account, "project", { plan_type: "business" }, 1000);
		const result = store.snapshot({ ...account, accountUserId: "seat-b" }, "project", 1000);
		expect(result.plan.status).toBe("unknown");
	});
	it("expires reset counts separately when the 30-minute interval passes", () => {
		const store = new RotationObservations();
		store.resets(account, "project", 2, 1000);
		const result = store.snapshot(account, "project", 1_801_000);
		expect(result.resetCredits).toMatchObject({ value: 2, status: "stale", source: "reset-list" });
	});
});
