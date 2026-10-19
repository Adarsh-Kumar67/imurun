/**
 * Tool registry — collects tool implementations and converts them to the
 * AI SDK tool format for the agent loop.
 *
 * Tools are registered WITHOUT execute functions: the agent loop executes
 * them manually so permission checks, UI events, and persistence all flow
 * through IMURUN's own machinery.
 */
import { jsonSchema, type ToolSet } from "ai"
import type { JSONSchema7 } from "ai"
import type { ImurunTool } from "./types"
import { readTool } from "./read"
import { writeTool } from "./write"
import { editTool } from "./edit"
import { shellTool } from "./shell"
import { globTool } from "./glob"
import { grepTool } from "./grep"
import { memoryTool } from "./memory"
import { progressTool } from "./progress"
import { todoTool } from "./todo"
import { planTool } from "./plan"
import { codeSearchTool } from "./rag"
import { screenshotTool } from "./screenshot"
import { webFetchTool, webSearchTool } from "./web"

export class ToolRegistry {
  private tools = new Map<string, ImurunTool>()

  register(tool: ImurunTool): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`)
    }
    this.tools.set(tool.name, tool)
    return this
  }

  unregister(name: string): void {
    this.tools.delete(name)
  }

  get(name: string): ImurunTool | undefined {
    return this.tools.get(name)
  }

  list(): ImurunTool[] {
    return [...this.tools.values()]
  }

  /** Converts registered tools into AI SDK tool definitions (no execute). */
  toAiSdkTools(): ToolSet {
    const set: ToolSet = {}
    for (const tool of this.tools.values()) {
      set[tool.name] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters as JSONSchema7),
      }
    }
    return set
  }

  /** Default IMURUN tool set for the current milestone. */
  static default(): ToolRegistry {
    return new ToolRegistry()
      .register(readTool)
      .register(writeTool)
      .register(editTool)
      .register(shellTool)
      .register(globTool)
      .register(grepTool)
      .register(codeSearchTool)
      .register(memoryTool)
      .register(progressTool)
      .register(todoTool)
      .register(planTool)
      .register(webSearchTool)
      .register(webFetchTool)
      .register(screenshotTool)
  }
}
