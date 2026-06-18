import { Router, Request, Response } from 'express'
import {
  listConversations, getConversation, createConversation,
  renameConversation, deleteConversation, getMessages,
  runChatTurn, isGenerating, getActiveAgentModel, TOOLS,
  getAgenticToolsConfig,
} from '../../agent/index.js'

export const router = Router()

const errOut = (res: Response, err: unknown) =>
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })

// Active agent model (for the page badge) + the catalogue of tools the agent can use.
router.get('/agent/meta', (_req: Request, res: Response) => {
  try {
    const m = getActiveAgentModel()
    res.json({
      model: { model: m.model, baseURL: m.baseURL },
      tools: TOOLS.map(t => ({ name: t.name, description: t.description, readOnly: t.readOnly })),
    })
  } catch (err) { errOut(res, err) }
})

// The shared tool catalog + each tool-calling agent's resolved per-tool grants, for the
// Settings → Agent → Agentic Tools editor. Saving goes through PUT /settings
// (agent_tool_permissions); this endpoint is the read side that drives the UI.
router.get('/agent/tools-config', (_req: Request, res: Response) => {
  try {
    res.json(getAgenticToolsConfig())
  } catch (err) { errOut(res, err) }
})

router.get('/agent/conversations', async (_req: Request, res: Response) => {
  try {
    res.json(await listConversations())
  } catch (err) { errOut(res, err) }
})

router.post('/agent/conversations', async (_req: Request, res: Response) => {
  try {
    res.json(await createConversation())
  } catch (err) { errOut(res, err) }
})

router.get('/agent/conversations/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' })
    const convo = await getConversation(id)
    if (!convo) return res.status(404).json({ error: 'Conversation not found' })
    res.json({ conversation: convo, messages: await getMessages(id), generating: isGenerating(id) })
  } catch (err) { errOut(res, err) }
})

router.patch('/agent/conversations/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' })
    if (!(await getConversation(id))) return res.status(404).json({ error: 'Conversation not found' })
    const title = String((req.body as { title?: string })?.title ?? '').trim()
    if (!title) return res.status(400).json({ error: 'Title required' })
    await renameConversation(id, title)
    res.json(await getConversation(id))
  } catch (err) { errOut(res, err) }
})

router.delete('/agent/conversations/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' })
    await deleteConversation(id)
    res.json({ ok: true })
  } catch (err) { errOut(res, err) }
})

// Send a message and run one full agent turn. Resolves once the agent has produced
// its final answer; live progress (tool calls/results) streams over the WebSocket as
// `agent_step` events in the meantime.
router.post('/agent/conversations/:id/chat', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' })
    if (!(await getConversation(id))) return res.status(404).json({ error: 'Conversation not found' })
    if (isGenerating(id)) return res.status(409).json({ error: 'A response is already being generated' })

    const message = String((req.body as { message?: string })?.message ?? '').trim()
    if (!message) return res.status(400).json({ error: 'Message required' })

    const { produced } = await runChatTurn(id, message)
    res.json({ messages: produced })
  } catch (err) { errOut(res, err) }
})
