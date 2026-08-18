import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: false,
		environment: "node",
		// 每个测试文件加载前清除 subagent spawn 注入的进程身份标记
		// （PI_SUBAGENT_DEPTH / PI_CURRENT_AGENT_NAME），使沙箱 shell 中
		// 跑测试与干净主 agent shell 行为一致。详见 test/setup-env.ts。
		setupFiles: ["./test/setup-env.ts"],
	},
});
