import { validateToolCall } from "@mariozechner/pi-ai";
import type { Tool as PiAiTool, ToolCall } from "@mariozechner/pi-ai";
import type {
  RegisteredTool,
  Tool,
  ToolContext,
  ToolExecutor,
  ToolResult,
  ToolScope,
} from "./types.js";

/**
 * Registry for managing and executing agent tools
 */
export class ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();
  private scopes: Map<string, ToolScope> = new Map();

  /**
   * Register a new tool with optional scope
   */
  register<TParams = unknown>(
    tool: Tool,
    executor: ToolExecutor<TParams>,
    scope?: ToolScope
  ): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, { tool, executor: executor as ToolExecutor });
    if (scope && scope !== "always") {
      this.scopes.set(tool.name, scope);
    }
  }

  /**
   * Get all registered tools for pi-ai
   */
  getAll(): PiAiTool[] {
    return Array.from(this.tools.values()).map((rt) => rt.tool);
  }

  /**
   * Execute a tool call from the LLM
   */
  async execute(toolCall: ToolCall, context: ToolContext): Promise<ToolResult> {
    const registered = this.tools.get(toolCall.name);

    if (!registered) {
      return {
        success: false,
        error: `Unknown tool: ${toolCall.name}`,
      };
    }

    // Enforce scope: block dm-only tools in groups and group-only tools in DMs
    const scope = this.scopes.get(toolCall.name);
    if (scope === "dm-only" && context.isGroup) {
      return {
        success: false,
        error: `Tool "${toolCall.name}" is not available in group chats`,
      };
    }
    if (scope === "group-only" && !context.isGroup) {
      return {
        success: false,
        error: `Tool "${toolCall.name}" is only available in group chats`,
      };
    }

    try {
      // Validate arguments against the tool's schema
      const validatedArgs = validateToolCall(this.getAll(), toolCall);

      // Execute the tool
      const result = await registered.executor(validatedArgs, context);

      return result;
    } catch (error) {
      console.error(`Error executing tool ${toolCall.name}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get tools respecting a provider's tool limit
   */
  getForProvider(toolLimit: number | null): PiAiTool[] {
    const all = this.getAll();
    if (toolLimit === null || all.length <= toolLimit) {
      return all;
    }
    console.warn(
      `⚠️ Provider tool limit: ${toolLimit}, registered: ${all.length}. Truncating to ${toolLimit} tools.`
    );
    return all.slice(0, toolLimit);
  }

  /**
   * Get tools filtered by chat context (DM vs group) and provider limit.
   * - In groups: excludes "dm-only" tools (financial, private)
   * - In DMs: excludes "group-only" tools (moderation)
   */
  getForContext(isGroup: boolean, toolLimit: number | null): PiAiTool[] {
    const excluded = isGroup ? "dm-only" : "group-only";
    const filtered = Array.from(this.tools.values())
      .filter((rt) => this.scopes.get(rt.tool.name) !== excluded)
      .map((rt) => rt.tool);

    if (toolLimit !== null && filtered.length > toolLimit) {
      console.warn(
        `⚠️ Provider tool limit: ${toolLimit}, after scope filter: ${filtered.length}. Truncating to ${toolLimit} tools.`
      );
      return filtered.slice(0, toolLimit);
    }
    return filtered;
  }

  /**
   * Check if a tool is registered
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get the number of registered tools
   */
  get count(): number {
    return this.tools.size;
  }

  /**
   * Get the category of a tool by name
   */
  getToolCategory(name: string): "data-bearing" | "action" | undefined {
    const registered = this.tools.get(name);
    return registered?.tool.category;
  }
}
