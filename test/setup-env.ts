/**
 * Vitest 全局 setup：测试进程环境密闭化（每个测试文件加载前执行一次）。
 *
 * 背景：本扩展 spawn 子 agent 进程时注入两个进程身份标记
 * （见 src/index.ts runSingleAgent 的 env 块）：
 *   - PI_SUBAGENT_DEPTH      — 当前递归深度（主 agent 未设置，子 agent ≥ 1）
 *   - PI_CURRENT_AGENT_NAME  — 当前 agent 名称
 *
 * 当测试在 subagent 沙箱 shell 中运行时（该 shell 自带
 * PI_SUBAGENT_DEPTH=1），vitest worker 继承这些变量，导致
 * before_agent_start 钩子的深度守卫（depth >= 1 跳过注入）在
 * "主 agent 基线"测试里误触发，基线整体偏移（system-prompt-injection
 * 契约 4-7、11 曾因此在沙箱内集体转红）。
 *
 * 在此删除这两个 spawn 注入的身份标记，使无论 npm test 在哪种 shell
 * 中启动，测试基线都等价于干净的主 agent 进程。
 *
 * 与既有 per-file 约定的关系：各测试文件的 ENV_KEYS save/pin/restore
 * 模式不受影响 —— beforeEach 保存到的基线即"未设置"，afterEach 恢复为
 * 删除，与在开发机普通 shell 中运行的行为完全一致。需要在用例内覆盖
 * 这些变量的测试（如深度守卫用例）仍自行显式设置。
 *
 * 注意：tunable 类变量（PI_SUBAGENT_*_TIMEOUT_MS、PI_CAN_DELEGATE 等）
 * 是合法的 shell 配置输入，不在此清理，仍由关心它们的测试文件逐文件钉死。
 */

delete process.env.PI_SUBAGENT_DEPTH;
delete process.env.PI_CURRENT_AGENT_NAME;
