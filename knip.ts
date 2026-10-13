import { application } from "@yuu1111/knip-config/application";

export default {
	...application,
	entry: ["quality.json", "tests/**/*.test.ts"],
	project: ["scripts/**/*.ts", "tests/**/*.ts"],
};
