/**
 * Auto-disable attribution (#288).
 *
 * A bare `enabled: false` reads as operator intent, so accounts the plugin
 * disabled itself (repeated auth failures, workspace deactivation) must
 * carry an explicit marker note — distinguishable in diagnostics, stripped
 * on re-enable, preserving operator text around it.
 */
import { describe, expect, it, vi } from "vitest";

import { AccountManager } from "../lib/accounts.js";
import {
	appendAutoDisableNote,
	AUTH_FAILURE_DISABLE_NOTE_MARKER,
	describeDisabledReason,
	hasAuthFailureDisableNote,
	hasAutoDisableNote,
	stripAutoDisableNote,
	WORKSPACE_DEACTIVATED_NOTE_MARKER,
} from "../lib/accounts/state.js";
import {
	withAccountStorageTransaction,
	type AccountStorageV3,
} from "../lib/storage.js";

vi.mock("../lib/storage.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/storage.js")>();
	return {
		...actual,
		loadAccounts: vi.fn(async () => null),
		saveAccounts: vi.fn(async () => undefined),
		withAccountStorageTransaction: vi.fn(),
	};
});

const now = Date.now();

function makeManager(
	accounts: Array<Record<string, unknown>>,
): AccountManager {
	return new AccountManager(undefined, {
		version: 3,
		activeIndex: 0,
		accounts,
	} as never);
}

function baseAccount(overrides: Record<string, unknown> = {}) {
	return {
		refreshToken: "rt",
		email: "user@example.com",
		addedAt: now,
		lastUsed: now,
		...overrides,
	};
}

describe("auto-disable markers", () => {
	it("disableAccountsWithSameRefreshToken writes the auth-failure marker on every sibling", () => {
		const manager = makeManager([
			baseAccount({ refreshToken: "shared", organizationId: "org-a", accountId: "a1" }),
			baseAccount({ refreshToken: "shared", organizationId: "org-b", accountId: "a2" }),
		]);
		const target = manager.getAccountsSnapshot()[0]!;

		expect(manager.disableAccountsWithSameRefreshToken(target)).toBe(2);

		for (const account of manager.getAccountsSnapshot()) {
			expect(account.enabled).toBe(false);
			expect(hasAuthFailureDisableNote(account.accountNote)).toBe(true);
		}
	});

	it("disableAccountsByWorkspaceIdentity writes the workspace marker only on the target", () => {
		const manager = makeManager([
			baseAccount({ refreshToken: "shared", organizationId: "org-a", accountId: "a1" }),
			baseAccount({ refreshToken: "shared", organizationId: "org-b", accountId: "a2" }),
		]);
		const target = manager.getAccountsSnapshot()[0]!;

		expect(manager.disableAccountsByWorkspaceIdentity(target)).toBe(1);

		const [disabled, untouched] = manager.getAccountsSnapshot();
		expect(disabled!.enabled).toBe(false);
		expect(disabled!.accountNote).toContain(WORKSPACE_DEACTIVATED_NOTE_MARKER);
		expect(untouched!.enabled).not.toBe(false);
		expect(untouched!.accountNote).toBeUndefined();
	});

	it("appends the marker after existing operator note text", () => {
		const manager = makeManager([
			baseAccount({ accountNote: "weekday primary" }),
		]);
		const target = manager.getAccountsSnapshot()[0]!;

		manager.disableAccountsWithSameRefreshToken(target);

		expect(manager.getAccountsSnapshot()[0]!.accountNote).toBe(
			`weekday primary ${AUTH_FAILURE_DISABLE_NOTE_MARKER}`,
		);
	});

	it("setAccountEnabled(true) strips the marker, keeps operator text, and clears an auth-failure cooldown", () => {
		const manager = makeManager([
			baseAccount({
				enabled: false,
				accountNote: `weekday primary. ${AUTH_FAILURE_DISABLE_NOTE_MARKER}`,
				coolingDownUntil: now + 60_000,
				cooldownReason: "auth-failure",
			}),
		]);

		const reenabled = manager.setAccountEnabled(0, true);
		expect(reenabled).not.toBeNull();

		const account = manager.getAccountsSnapshot()[0]!;
		expect(account.enabled).toBe(true);
		expect(account.accountNote).toBe("weekday primary.");
		expect(account.coolingDownUntil).toBeUndefined();
		expect(account.cooldownReason).toBeUndefined();
	});

	it("setAccountEnabled(true) keeps a non-auth-failure cooldown", () => {
		const manager = makeManager([
			baseAccount({
				enabled: false,
				accountNote: AUTH_FAILURE_DISABLE_NOTE_MARKER,
				coolingDownUntil: now + 60_000,
				cooldownReason: "network-error",
			}),
		]);

		manager.setAccountEnabled(0, true);

		const account = manager.getAccountsSnapshot()[0]!;
		expect(account.enabled).toBe(true);
		expect(account.coolingDownUntil).toBe(now + 60_000);
		expect(account.cooldownReason).toBe("network-error");
	});

	it("setAccountEnabled(false) does not invent a marker for an operator disable", () => {
		const manager = makeManager([baseAccount({})]);

		manager.setAccountEnabled(0, false);

		const account = manager.getAccountsSnapshot()[0]!;
		expect(account.enabled).toBe(false);
		expect(hasAutoDisableNote(account.accountNote)).toBe(false);
	});
});

describe("describeDisabledReason via selection explainability", () => {
	function reasonsFor(accountNote: string | undefined): string[] {
		const manager = makeManager([
			baseAccount({ enabled: false, accountNote }),
		]);
		const entry = manager
			.getSelectionExplainability("codex", undefined, now)
			.find((candidate) => candidate.index === 0);
		expect(entry?.eligible).toBe(false);
		return entry?.reasons ?? [];
	}

	it("reports disabled:auth-failures for the auth-failure marker", () => {
		expect(reasonsFor(AUTH_FAILURE_DISABLE_NOTE_MARKER)).toContain(
			"disabled:auth-failures",
		);
	});

	it("reports disabled:workspace-deactivated for the workspace marker", () => {
		expect(reasonsFor(WORKSPACE_DEACTIVATED_NOTE_MARKER)).toContain(
			"disabled:workspace-deactivated",
		);
	});

	it("reports plain disabled for an operator disable with no marker", () => {
		expect(reasonsFor("not using this one")).toContain("disabled");
		expect(reasonsFor("not using this one")).not.toContain(
			"disabled:auth-failures",
		);
	});

	it("describeDisabledReason reports disabled:reauth-required for a missing-scope note", () => {
		expect(
			describeDisabledReason(
				"Re-auth required for missing OAuth scope(s): offline_access.",
			),
		).toBe("disabled:reauth-required");
	});
});

describe("auto-disable note helpers", () => {
	it("appendAutoDisableNote dedupes an existing marker and preserves other text", () => {
		const note = appendAutoDisableNote(
			`keep me. ${AUTH_FAILURE_DISABLE_NOTE_MARKER}`,
			AUTH_FAILURE_DISABLE_NOTE_MARKER,
		);
		expect(note).toBe(`keep me. ${AUTH_FAILURE_DISABLE_NOTE_MARKER}`);
	});

	it("stripAutoDisableNote removes a mid-string marker without eating surrounding text", () => {
		expect(
			stripAutoDisableNote(
				`before ${AUTH_FAILURE_DISABLE_NOTE_MARKER} after`,
			),
		).toBe("before after");
	});

	it("stripAutoDisableNote returns undefined when only markers remain", () => {
		expect(
			stripAutoDisableNote(
				`${AUTH_FAILURE_DISABLE_NOTE_MARKER} ${WORKSPACE_DEACTIVATED_NOTE_MARKER}`,
			),
		).toBeUndefined();
	});

	it("hasAutoDisableNote covers both markers and ignores plain notes", () => {
		expect(hasAutoDisableNote(AUTH_FAILURE_DISABLE_NOTE_MARKER)).toBe(true);
		expect(hasAutoDisableNote(WORKSPACE_DEACTIVATED_NOTE_MARKER)).toBe(true);
		expect(hasAutoDisableNote("operator did this")).toBe(false);
		expect(hasAutoDisableNote(undefined)).toBe(false);
	});
});

describe("auto-disable marker through saveToDisk", () => {
	function stubTransaction(disk: AccountStorageV3): AccountStorageV3[] {
		const persisted: AccountStorageV3[] = [];
		vi.mocked(withAccountStorageTransaction).mockImplementation(
			async (handler) =>
				handler(disk, async (storage) => {
					persisted.push(storage);
				}),
		);
		return persisted;
	}

	it("writes the in-memory marker onto the disk record when a pending disable lands", async () => {
		// Disk holds the pre-disable record: no enabled flag, no note. The
		// pending-disable merge takes the manager's own record for this slot,
		// so the reason must reach disk, not the old note (review: #290).
		const persisted = stubTransaction({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: {},
			accounts: [
				{ refreshToken: "rt", accountId: "a1", addedAt: now, lastUsed: now },
			],
		});
		const manager = makeManager([baseAccount({ accountId: "a1" })]);
		const target = manager.getAccountsSnapshot()[0]!;
		manager.disableAccountsWithSameRefreshToken(target);

		await manager.saveToDisk();

		expect(persisted).toHaveLength(1);
		const written = persisted[0]!.accounts[0]!;
		expect(written.enabled).toBe(false);
		expect(written.accountNote).toContain(AUTH_FAILURE_DISABLE_NOTE_MARKER);
	});

	it("lets a disk-side re-enable beat a stale in-memory disable with no pending entry", async () => {
		// A replacement manager that still holds the disabled snapshot cannot
		// re-apply it once disk says enabled — for a slot with no pending
		// disable the merge takes enabled + accountNote from disk (review: #290).
		const persisted = stubTransaction({
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: {},
			accounts: [
				{
					refreshToken: "rt",
					accountId: "a1",
					accountNote: "keep me",
					addedAt: now,
					lastUsed: now,
				},
			],
		});
		const manager = makeManager([
			baseAccount({
				accountId: "a1",
				enabled: false,
				accountNote: `operator text. ${AUTH_FAILURE_DISABLE_NOTE_MARKER}`,
			}),
		]);

		await manager.saveToDisk();

		expect(persisted).toHaveLength(1);
		const written = persisted[0]!.accounts[0]!;
		expect(written.enabled).not.toBe(false);
		expect(written.accountNote).toBe("keep me");
	});
});
