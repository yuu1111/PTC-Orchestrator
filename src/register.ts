import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/cordis-plugin-loader";
import * as policy from "./main.ts";

declare module "@deepseek-ai/cordis" {
	interface Context {
		ptcOrchestratorRuntime: boolean;
	}
}

export const inject = ["loader"];
export const provide = ["ptcOrchestratorRuntime"];

export function apply(ctx: Context) {
	const key = "ptc-orchestrator-ida-only";
	if (ctx.loader.builtins[key])
		throw new Error("PTC-Orchestrator policy runtime is already registered");
	ctx.effect(() => {
		ctx.loader.builtins[key] = policy;
		return () => {
			if (ctx.loader.builtins[key] === policy) delete ctx.loader.builtins[key];
		};
	});
	ctx.provide("ptcOrchestratorRuntime", true);
}
