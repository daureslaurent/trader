// Public API for the conversational Agent module. Import only from here.
export { runChatTurn, isGenerating, getActiveAgentModel } from './service.js'
export {
  listConversations, getConversation, createConversation,
  renameConversation, deleteConversation, getMessages,
} from './store.js'
export { TOOLS } from './tools.js'
export { getAgenticToolsConfig, AGENTS } from './registry.js'
export type { AgenticToolInfo, AgenticAgentInfo, ToolPermission } from './registry.js'
export { runMonitor, isRunning as isMonitorRunning, getMonitorRuns, getActiveReviews } from './monitor.js'
export { runAgentSignal, runAgentSignalCoin, isRunningSignal, getSignalRuns, getActiveSignalReviews } from './signalD.js'
export { runEntryAgent, runEntryAgentCoin, isRunningEntry, getEntryAgentRuns, getActiveEntryReviews } from './entryAgent.js'
export { runCoach, isRunningCoach, getCoachRuns, getActiveCoachReview } from './coach.js'
export { getCoachMemory } from './tools.js'
export type { ActiveCoachReview } from './coach.js'
export type { ChatTurnResult } from './service.js'
