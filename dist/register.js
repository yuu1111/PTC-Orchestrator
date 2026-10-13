import * as policy from "./main.js";
export const inject = ["loader"];
export const provide = ["localOrchestratorRuntime"];
export function apply(ctx) {
    const key = "local-orchestrator-ida-only";
    if (ctx.loader.builtins[key])
        throw new Error("Local Orchestrator policy runtime is already registered");
    ctx.effect(() => {
        ctx.loader.builtins[key] = policy;
        return () => {
            if (ctx.loader.builtins[key] === policy)
                delete ctx.loader.builtins[key];
        };
    });
    ctx.provide("localOrchestratorRuntime", true);
}
