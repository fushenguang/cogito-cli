import { join } from 'path'
import { getTemplates, getTemplate } from '../../core/registry.js'
import { scaffoldProject } from '../../core/scaffold.js'

export interface McpTool {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  handler: (input: Record<string, unknown>) => Promise<unknown>
}

export const listTemplatesTool: McpTool = {
  name: 'list_templates',
  description: 'List all available Cogito project templates',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  async handler(_input) {
    const templates = getTemplates()
    return {
      templates: templates.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        minCliVersion: t.minCliVersion,
      })),
    }
  },
}

export const scaffoldProjectTool: McpTool = {
  name: 'scaffold_project',
  description: 'Scaffold a new Cogito project from a template into the specified directory',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Project name (used as directory name and package name)',
      },
      template: {
        type: 'string',
        description: 'Template ID (e.g. web-nextjs)',
      },
      targetDir: {
        type: 'string',
        description: 'Absolute path to the target directory. Defaults to cwd/<name>.',
      },
      packageManager: {
        type: 'string',
        enum: ['pnpm', 'npm', 'yarn', 'bun'],
        description: 'Package manager to suggest in README. Defaults to pnpm.',
      },
    },
    required: ['name', 'template'],
  },
  async handler(input) {
    const {
      name,
      template: templateId,
      targetDir,
      packageManager,
    } = input as {
      name: string
      template: string
      targetDir?: string
      packageManager?: 'pnpm' | 'npm' | 'yarn' | 'bun'
    }

    const template = getTemplate(templateId)
    if (!template) {
      return {
        ok: false,
        error: 'TEMPLATE_NOT_FOUND',
        template: templateId,
      }
    }

    const resolvedTargetDir = targetDir ?? join(process.cwd(), name)

    return scaffoldProject({
      targetDir: resolvedTargetDir,
      name,
      template,
      packageManager: packageManager ?? 'pnpm',
    })
  },
}

export const getTemplateSchemaTool: McpTool = {
  name: 'get_template_schema',
  description: 'Get the full metadata and resolved dependency schema for a specific template',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Template ID (e.g. web-nextjs)',
      },
    },
    required: ['id'],
  },
  async handler(input) {
    const { id } = input as { id: string }
    const template = getTemplate(id)
    if (!template) {
      return {
        ok: false,
        error: 'TEMPLATE_NOT_FOUND',
        template: id,
      }
    }
    return { ok: true, template }
  },
}

export const ALL_TOOLS: McpTool[] = [listTemplatesTool, scaffoldProjectTool, getTemplateSchemaTool]
