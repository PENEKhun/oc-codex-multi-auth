import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	hostAuthFilePath,
	readHostOpenAIOAuth,
} from "../lib/host-auth.js";

describe("readHostOpenAIOAuth", () => {
	let dataHome: string;

	beforeEach(async () => {
		// Point the reader at a scratch XDG_DATA_HOME so the test never sees the
		// developer's real auth.json.
		dataHome = await mkdtemp(join(tmpdir(), "host-auth-test-"));
		vi.stubEnv("XDG_DATA_HOME", dataHome);
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await rm(dataHome, { recursive: true, force: true });
	});

	async function writeAuthStore(store: unknown): Promise<void> {
		const dir = join(dataHome, "opencode");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "auth.json"), JSON.stringify(store), "utf8");
	}

	it("resolves the same auth.json path the backfill writes", () => {
		expect(hostAuthFilePath()).toBe(
			join(dataHome, "opencode", "auth.json"),
		);
	});

	it("returns null when the host auth store does not exist", async () => {
		expect(await readHostOpenAIOAuth()).toBeNull();
	});

	it("returns the openai oauth entry when present", async () => {
		await writeAuthStore({
			openai: {
				type: "oauth",
				access: "access-token",
				refresh: "refresh-token",
				expires: 1_800_000_000_000,
				scope: "openid profile",
			},
		});

		expect(await readHostOpenAIOAuth()).toEqual({
			access: "access-token",
			refresh: "refresh-token",
			expires: 1_800_000_000_000,
			scope: "openid profile",
		});
	});

	it("returns null for a non-oauth host entry", async () => {
		await writeAuthStore({
			openai: { type: "api", key: "sk-test" },
		});

		expect(await readHostOpenAIOAuth()).toBeNull();
	});

	it("returns null for malformed JSON", async () => {
		const dir = join(dataHome, "opencode");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "auth.json"), "{not json", "utf8");

		expect(await readHostOpenAIOAuth()).toBeNull();
	});

	it("returns null when oauth fields are missing or empty", async () => {
		await writeAuthStore({
			openai: { type: "oauth", access: "", refresh: "r", expires: 1 },
		});

		expect(await readHostOpenAIOAuth()).toBeNull();
	});

	it("reads a different provider id when asked", async () => {
		await writeAuthStore({
			custom: {
				type: "oauth",
				access: "a",
				refresh: "r",
				expires: 1,
			},
		});

		expect(await readHostOpenAIOAuth("custom")).toMatchObject({
			access: "a",
			refresh: "r",
		});
		expect(await readHostOpenAIOAuth()).toBeNull();
	});
});
