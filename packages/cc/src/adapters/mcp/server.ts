import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { ALL_TOOLS } from './tools.js'
import { VERSION } from '../../version.js'

export async function startMcpServer(): Promise<void> {
  const server = new Server(
    { name: 'cc', version: VERSION },
    {
      capabilities: {
        tools: {},
      },
    },
  )

  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: ALL_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    }
  })

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    const tool = ALL_TOOLS.find((t) => t.name === name)

    if (!tool) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: 'TOOL_NOT_FOUND', tool: name }),
          },
        ],
      }
    }

    try {
      const result = await tool.handler((args as Record<string, unknown>) ?? {})
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result),
          },
        ],
      }
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: 'TOOL_EXECUTION_FAILED',
              message: err instanceof Error ? err.message : String(err),
            }),
          },
        ],
      }
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)

  // Graceful shutdown
  process.on('SIGINT', async () => {
    await server.close()
    process.exit(0)
  })

  process.on('SIGTERM', async () => {
    await server.close()
    process.exit(0)
  })
}
