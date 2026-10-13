import { application } from "@yuu1111/knip-config/application";

export default {
	...application,
	entry: [
		"quality.json",
		"src/ida-only.ts",
		"src/register.ts",
		"tests/**/*.test.ts",
	],
	project: ["src/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts"],
};
