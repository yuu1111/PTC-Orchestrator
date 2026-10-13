import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/cordis-plugin-loader";
import * as policy from "./ida-only.ts";

declare module "@deepseek-ai/cordis" {
	interface Context {
		localOrchestratorRuntime: boolean;
	}
}

export const inject = ["loader"];
export const provide = ["localOrchestratorRuntime"];

export function apply(ctx: Context) {
	const key = "local-orchestrator-ida-only";
	if (ctx.loader.builtins[key])
		throw new Error("Local Orchestrator policy runtime is already registered");
	ctx.effect(() => {
		ctx.loader.builtins[key] = policy;
		return () => {
			if (ctx.loader.builtins[key] === policy) delete ctx.loader.builtins[key];
		};
	});
	ctx.provide("localOrchestratorRuntime", true);
}
